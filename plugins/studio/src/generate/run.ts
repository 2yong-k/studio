import { basename, extname, join } from 'node:path';
import type { Mode } from '../config.ts';
import { type ErrorCode, type JsonValue, StudioError } from '../errors.ts';
import { probe } from '../make/index.ts';
import { type Micros, parseMicros } from '../money/index.ts';
import {
  type AttemptView,
  acceptedOf,
  appendSpend,
  attempts,
  type Brief,
  type BriefCtx,
  briefHash,
  briefPath,
  confirmedKeyframeShas,
  ESTIMATE_FILE,
  type Estimate,
  EstimateSchema,
  elementInputHash,
  elementSize,
  type GenerateImage,
  type GenerateVideo,
  latestEstimateApproval,
  type ModelEntry,
  nextAttemptNo,
  type Outcome,
  type Params,
  type ResolvedSize,
  readJsonHashed,
  type SentRequest,
  type SpendLine,
  type SpendState,
  sameRatio,
  sha256File,
  unresolvedOf,
  withWorkLock,
  workSpend,
} from '../works/index.ts';
import { checkRaw } from './check.ts';
import { downloadChecked } from './download.ts';
import { pendingOf, refuseStaleGuide } from './estimate.ts';
import { DOWNLOAD_LIMIT_BYTES, FAILED_REQUEST_BILLED, WAIT_LIMIT_MS } from './limits.ts';
import { type BillingRequest, billingQuantity, lineAmount, sameParamsRows } from './pricing.ts';
import type { Expect, Provider, ProviderResult, ProviderStatus, ProviderUsage, ResultFile } from './provider.ts';

export type GenCtx = {
  mode: Mode;
  ctx: BriefCtx;
  brief: Brief;
  // The hash of the exact bytes `brief` was parsed from.
  briefHash: string;
  provider: Provider;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
};

// Settling reads the request pinned on the spend lines, never the brief, so `status` works on a brief edited since.
export type SettleCtx = Pick<GenCtx, 'ctx' | 'provider' | 'now' | 'sleep' | 'pollMs'>;

type AttemptResult = {
  attempt: string;
  element: string;
  state: SpendState;
  outcome: Outcome | null;
  amountMicros: string;
  file: string | null;
  // The line's reason (a refusal's text, a failed check, a re-make's defect), so Claude need not read spend.jsonl.
  reason: string | null;
  error: ErrorCode | null;
  // The caught error behind `error`, as text: the user resolves an attempt from it (a missing key proves it was not sent).
  cause: string | null;
};

type Next = 'keyframe_review' | 'make' | 'nothing';
type Generated = GenerateImage | GenerateVideo;
type Size = { w: number; h: number };
type Upload = SpendLine['uploads'][number];
// What settling reads: the request pinned on the attempt's lines and the model they name, never the brief.
type Pinned = { model: ModelEntry; request: SentRequest; expect: Expect };
type Request = Pinned & { el: Generated; size: ResolvedSize };
type Price = { unitPriceMicros: Micros; unitSize: bigint };
type Billed = Pick<SpendLine, 'unit' | 'quantity' | 'amountMicros' | 'amountBasis'>;
type Planned = Billed & Pick<SpendLine, 'unitPriceMicros' | 'unitSize'>;
type Settlement = Billed & Pick<SpendLine, 'outcome' | 'reason' | 'sourceUrl' | 'file' | 'sha256'>;
type Failure = { error: ErrorCode; cause: string | null };
type Open = { kind: 'open' } & Failure;
type Polled = { kind: 'completed' } | { kind: 'failed'; error: string | null } | Open;

const CANONICAL_INT = /^(0|[1-9][0-9]*)$/;
const PATH_SEGMENT = /^[^/\\]+$/;
const REASON_MAX = 500;
const EXT_BY_TYPE: ReadonlyMap<string, string> = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['video/mp4', 'mp4'],
  ['video/quicktime', 'mov'],
]);
const KNOWN_EXT: ReadonlySet<string> = new Set(EXT_BY_TYPE.values());

function resultOf(line: SpendLine, failure: Failure | null): AttemptResult {
  const { attempt, element, state, outcome, amountMicros, file, reason } = line;
  return {
    attempt,
    element,
    state,
    outcome,
    amountMicros,
    file,
    reason,
    error: failure?.error ?? null,
    cause: failure?.cause ?? null,
  };
}

function causeText(e: unknown): string {
  if (e instanceof StudioError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

const causeOf = (e: unknown): string => causeText(e).slice(0, REASON_MAX);

const openOf = (e: unknown): Open => ({
  kind: 'open',
  error: e instanceof StudioError ? e.code : 'PROVIDER_ERROR',
  cause: causeOf(e),
});

// Rethrown with more details, so the user can tell which attempt it left open; a non-StudioError becomes UNEXPECTED.
// The original stays as the cause, so its stack still reaches stderr.
function withDetails(e: unknown, named: Readonly<Record<string, JsonValue>>): StudioError {
  if (!(e instanceof StudioError)) {
    const wrapped = new StudioError('UNEXPECTED', causeOf(e), { ...named });
    wrapped.cause = e;
    return wrapped;
  }
  const d: JsonValue = e.details ?? {};
  const own = typeof d === 'object' && d !== null && !Array.isArray(d) ? d : { details: d };
  const out = new StudioError(e.code, e.message, { ...own, ...named });
  if (e.cause !== undefined) out.cause = e.cause;
  return out;
}

// Attempts finished before the throw may have cost money, so they ride on the error instead of being lost.
const carrying = (e: unknown, results: readonly AttemptResult[]): unknown =>
  results.length === 0 ? e : withDetails(e, { results: [...results] });

// Only an absent file reads as "none"; any other read failure still throws.
async function unlessMissing<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof StudioError && e.code === 'NOT_FOUND') return null;
    throw e;
  }
}

function generatedOf(brief: Brief, id: string): Generated {
  const index = brief.elements.findIndex((e) => e.id === id);
  const el = brief.elements[index];
  if (el === undefined || el.method !== 'generate') {
    throw new StudioError('NOT_FOUND', `${id} is not a generated element of this brief`, { element: id });
  }
  // The id names a folder under raw/, so it has to stay one path segment.
  if (!PATH_SEGMENT.test(el.id) || el.id === '.' || el.id === '..') {
    const reason = 'a generated element id must be a single path segment';
    throw new StudioError('BRIEF_INVALID', reason, {
      issues: [{ path: `elements.${index}.id`, code: 'BRIEF_INVALID', reason }],
    });
  }
  return el;
}

function modelOf(ctx: BriefCtx, id: string): ModelEntry {
  const m = ctx.models.get(id);
  if (m === undefined) throw new StudioError('UNEXPECTED', `unknown model ${id}`, { model: id });
  return m;
}

// The request is built from g.brief, so a brief read before an edit and re-approval is as stale as the edited file.
async function staleField(g: GenCtx, approval: { mode: Mode; briefHash: string; estimateHash: string }, hash: string) {
  if (approval.mode !== g.mode) return 'mode';
  if (approval.briefHash !== g.briefHash || approval.briefHash !== (await briefHash(g.ctx.workDir))) return 'briefHash';
  return approval.estimateHash === hash ? null : 'estimateHash';
}

async function approvedEstimate(g: GenCtx): Promise<{ estimate: Estimate; capMicros: Micros }> {
  const { workDir } = g.ctx;
  const approval = await latestEstimateApproval(workDir);
  const read =
    approval === null ? null : await unlessMissing(readJsonHashed(join(workDir, ESTIMATE_FILE), EstimateSchema));
  if (approval === null || read === null) {
    throw new StudioError('NOT_APPROVED', 'no approved estimate for this work; estimate and approve first', {
      missing: approval === null ? 'approval' : 'estimate',
    });
  }
  const field = await staleField(g, approval, read.sha256);
  if (field !== null) {
    throw new StudioError('APPROVAL_STALE', `the approval no longer matches the work's ${field}`, { field });
  }
  return { estimate: read.value, capMicros: parseMicros(approval.capMicros) };
}

// Each may have been paid for, so the same inputs go again only when the user names the element.
const FAILED_OUTCOMES: ReadonlySet<Outcome | null> = new Set(['rejected', 'provider_failed', 'refused']);

// What the provider last made of these exact inputs; a not_sent attempt never reached it, so it tells nothing.
function lastSettledOf(views: readonly AttemptView[], element: string, inputHash: string): AttemptView | null {
  const settled = (v: AttemptView): boolean => v.last.state === 'settled' && v.last.outcome !== 'not_sent';
  return views.findLast((v) => v.element === element && v.last.inputHash === inputHash && settled(v)) ?? null;
}

// The provider documents a refusal as not retryable: the same inputs would be refused, and billed, again.
function refuseRefusedInput(views: readonly AttemptView[], element: string, inputHash: string): void {
  const last = lastSettledOf(views, element, inputHash);
  if (last?.last.outcome !== 'refused') return;
  const why = `the provider refused ${element}'s inputs in ${last.attempt}; change the prompt, inputs or model first`;
  throw new StudioError('INPUT_REFUSED', why, { element, attempt: last.attempt, reason: last.last.reason });
}

function refuseUnresolved(views: readonly AttemptView[], element: string): void {
  const open = unresolvedOf(views, element);
  if (open === null) return;
  throw new StudioError('ATTEMPT_UNRESOLVED', `${element} has an unresolved attempt ${open.attempt}`, {
    element,
    attempt: open.attempt,
    state: open.last.state,
  });
}

async function acceptedKeyframe(g: GenCtx, views: readonly AttemptView[], id: string): Promise<AttemptView | null> {
  return acceptedOf(views, id, await elementInputHash(g.ctx, g.brief, id));
}

// The user confirms a keyframe by its sha, so a raw file edited since is not the one they saw.
async function confirmedKeyframe(g: GenCtx, views: readonly AttemptView[], element: string, keyframe: string) {
  const { workDir } = g.ctx;
  const accepted = await acceptedKeyframe(g, views, keyframe);
  const file = accepted?.last.file ?? null;
  const sha256 = accepted?.last.sha256 ?? null;
  const confirmed = sha256 !== null && (await confirmedKeyframeShas(workDir)).has(sha256);
  if (file === null || sha256 === null || !confirmed || (await sha256File(join(workDir, file))) !== sha256) {
    throw new StudioError('KEYFRAME_NOT_CONFIRMED', `keyframe ${keyframe} has no accepted file the user confirmed`, {
      element,
      keyframe,
    });
  }
  return { file, sha256 };
}

// A given file was chosen by the user before it went into the brief, so it is sent as it is now; a generated keyframe
// goes only as the accepted file the user confirmed.
async function firstFrameOf(
  g: GenCtx,
  views: readonly AttemptView[],
  video: GenerateVideo,
): Promise<{ path: string; abs: string; sha256: string }> {
  if (video.fromFile !== undefined) {
    const abs = briefPath(g.ctx, video.fromFile);
    return { path: video.fromFile, abs, sha256: await sha256File(abs) };
  }
  if (video.from === undefined) {
    throw new StudioError('UNEXPECTED', `${video.id} opens on nothing`, { element: video.id });
  }
  const { file, sha256 } = await confirmedKeyframe(g, views, video.id, video.from);
  return { path: file, abs: join(g.ctx.workDir, file), sha256 };
}

// The clip keeps the first frame's ratio, so a last frame of another ratio cannot be its end; it is refused before
// anything is uploaded or paid for. The rule is the brief check's, which reads the stored size of two files; this
// check also covers a generated keyframe and a file changed since.
async function lastFrameOf(
  g: GenCtx,
  video: GenerateVideo,
  index: number,
  firstAbs: string,
): Promise<{ path: string; abs: string; sha256: string } | null> {
  if (video.toFile === undefined) return null;
  const abs = briefPath(g.ctx, video.toFile);
  const [w1, h1] = await pictureSize(firstAbs);
  const [w2, h2] = await pictureSize(abs);
  if (!sameRatio([w1, h1], [w2, h2])) {
    const reason = `the last frame ${video.toFile} is ${w2}x${h2}, not the ratio of the first frame ${w1}x${h1}`;
    const path = `elements.${index}.toFile`;
    throw new StudioError('BRIEF_INVALID', reason, { issues: [{ path, code: 'BRIEF_INVALID', reason }] });
  }
  return { path: video.toFile, abs, sha256: await sha256File(abs) };
}

const paid = (v: AttemptView): boolean => v.last.outcome === 'accepted' || v.last.outcome === 'rejected';

// A re-make after review may have no estimate line; what its last paid attempt of the same request cost prices it, at
// the unit price that attempt pinned. A not_sent, provider_failed or refused attempt can cost 0, so it never does, and
// an attempt with other inputs (the hash covers the model too) bills another quantity, unit or price.
function plannedAmount(estimate: Estimate, views: readonly AttemptView[], el: Generated, inputHash: string): Planned {
  const line = estimate.lines.find((l) => l.element === el.id);
  const from = line ?? views.findLast((v) => v.element === el.id && v.last.inputHash === inputHash && paid(v))?.last;
  if (from === undefined) {
    const why = `${el.id} has no estimate line and no paid attempt of its current inputs to price it`;
    throw new StudioError('NOT_APPROVED', why, { element: el.id });
  }
  const { unit, unitPriceMicros, unitSize, quantity, amountMicros } = from;
  return { unit, unitPriceMicros, unitSize, quantity, amountMicros, amountBasis: 'estimate' };
}

// The cap is the one bound on retries. Never loosen it here: more work needs a new approved estimate.
async function checkCap(workDir: string, amount: Micros, capMicros: Micros): Promise<void> {
  const spend = await workSpend(workDir);
  if (spend + amount <= capMicros) return;
  throw new StudioError('CAP_EXCEEDED', 'this attempt would take work spend past the approved cap', {
    spendMicros: spend.toString(),
    amountMicros: amount.toString(),
    capMicros: capMicros.toString(),
  });
}

// Strictly nearer the keyframe's ratio, or as near and larger. Cross-multiplied, so no float ratio decides.
function nearer(a: Size, b: Size, [kw, kh]: readonly [number, number]): boolean {
  const da = Math.abs(a.w * kh - a.h * kw) * b.h;
  const db = Math.abs(b.w * kh - b.h * kw) * a.h;
  return da < db || (da === db && a.w * a.h > b.w * b.h);
}

// ffprobe prints 0x0 and exits 0 for a picture it cannot decode, and 0x0 would pass any ratio rule.
async function pictureSize(file: string): Promise<[number, number]> {
  const info = await probe(file);
  if (!info.hasVideo || info.width <= 0 || info.height <= 0)
    throw new StudioError('UNEXPECTED', `${file} has no picture to take a ratio from`, { file });
  return [info.width, info.height];
}

// One reading of a pinned request, so the submit and every later settle expect the same output.
function pinned(model: ModelEntry, request: SentRequest): Pinned {
  const { output, w, h, durationMs } = request;
  return { model, request, expect: { output, w, h, durationMs, fps: model.fps, audio: model.audio } };
}

// Rows that share the sent params differ only in ratio, which the provider takes from the first frame.
async function requestOf(g: GenCtx, el: Generated, firstFrameAbs: string | null): Promise<Request> {
  const model = modelOf(g.ctx, el.model);
  const size = elementSize(g.ctx, g.brief, el.id);
  const asked = { w: size.w, h: size.h, promptBytes: Buffer.byteLength(el.prompt, 'utf8'), follows: null };
  const request: SentRequest =
    el.output === 'image'
      ? { ...asked, output: 'image', durationMs: null }
      : { ...asked, output: 'video', durationMs: el.durationMs };
  const rows = el.output === 'video' ? sameParamsRows(model, size) : [];
  if (rows.length < 2) return { ...pinned(model, request), el, size };
  if (firstFrameAbs === null) {
    throw new StudioError('UNEXPECTED', `${el.id} has no first-frame file`, { element: el.id });
  }
  const keyframe = await pictureSize(firstFrameAbs);
  const best = rows.reduce((a, b) => (nearer(b, a, keyframe) ? b : a));
  const follows = { keyframe, rows: rows.map((r): [number, number] => [r.w, r.h]) };
  return { ...pinned(model, { ...request, w: best.w, h: best.h, follows }), el, size };
}

async function uploaded(g: GenCtx, path: string, abs: string, sha256?: string): Promise<Upload> {
  return { path, sha256: sha256 ?? (await sha256File(abs)), url: await g.provider.upload(abs) };
}

// In the order the refs slot lists them: the brief's refs, then the layout guide.
async function uploadRefs(g: GenCtx, el: Generated): Promise<Upload[]> {
  if (el.output !== 'image') return [];
  const refs = (el.refs ?? []).map((rel) => ({ rel, abs: briefPath(g.ctx, rel) }));
  const guide = `preview/ref-${el.id}.png`;
  if (el.layoutRef === true) refs.push({ rel: guide, abs: join(g.ctx.workDir, guide) });
  const out: Upload[] = [];
  for (const r of refs) out.push(await uploaded(g, r.rel, r.abs));
  return out;
}

function slotOf(model: ModelEntry, name: string | null, what: string): string {
  if (name === null) throw new StudioError('UNEXPECTED', `model ${model.id} has no ${what} slot`, { model: model.id });
  return name;
}

function durationParams(model: ModelEntry, ms: number): Params {
  const d = model.durations.find((x) => x.ms === ms);
  if (d === undefined) throw new StudioError('UNEXPECTED', `model ${model.id} has no ${ms} ms`, { model: model.id });
  return d.params;
}

// Dotted keys stay as written; the provider's adapter expands them.
function paramsOf(
  req: Request,
  refs: readonly Upload[],
  frame: Upload | null,
  end: Upload | null,
): Record<string, JsonValue> {
  const { el, model } = req;
  const entries: [string, JsonValue][] = [
    ...Object.entries(model.fixedParams),
    ...Object.entries(req.size.params),
    ...(el.output === 'video' ? Object.entries(durationParams(model, el.durationMs)) : []),
    [model.slots.prompt, el.prompt],
  ];
  if (refs.length > 0) entries.push([slotOf(model, model.slots.refs?.param ?? null, 'refs'), refs.map((u) => u.url)]);
  if (frame !== null) entries.push([slotOf(model, model.slots.firstFrame, 'firstFrame'), frame.url]);
  if (end !== null) entries.push([slotOf(model, model.slots.lastFrame, 'lastFrame'), end.url]);
  return Object.fromEntries(entries);
}

// Whatever submit throws, the request may have reached the provider, so it is never sent again from here.
async function trySubmit(g: GenCtx, req: Request, params: Record<string, JsonValue>): Promise<string | Failure> {
  try {
    return (await g.provider.submit({ endpoint: req.model.endpoint, params, expect: req.expect })).requestId;
  } catch (e) {
    return { error: 'ATTEMPT_UNRESOLVED', cause: causeOf(e) };
  }
}

async function generateLocked(g: GenCtx, elementId: string, reason: string | null): Promise<AttemptResult> {
  const { workDir } = g.ctx;
  const { estimate, capMicros } = await approvedEstimate(g);
  const el = generatedOf(g.brief, elementId);
  const views = await attempts(workDir);
  refuseUnresolved(views, el.id);
  await refuseStaleGuide(g.ctx, g.brief, el.id);
  const first = el.output === 'video' ? await firstFrameOf(g, views, el) : null;
  const last =
    el.output === 'video' && first !== null ? await lastFrameOf(g, el, g.brief.elements.indexOf(el), first.abs) : null;
  const inputHash = await elementInputHash(g.ctx, g.brief, el.id);
  refuseRefusedInput(views, el.id, inputHash);
  const planned = plannedAmount(estimate, views, el, inputHash);
  await checkCap(workDir, parseMicros(planned.amountMicros), capMicros);
  const req = await requestOf(g, el, first?.abs ?? null);
  const refs = await uploadRefs(g, el);
  const frame = first === null ? null : await uploaded(g, first.path, first.abs, first.sha256);
  const end = last === null ? null : await uploaded(g, last.path, last.abs, last.sha256);
  const params = paramsOf(req, refs, frame, end);
  const submitting: SpendLine = {
    schema: 1,
    at: g.now().toISOString(),
    mode: g.mode,
    work: basename(workDir),
    element: el.id,
    attempt: `${basename(workDir)}/${el.id}/${await nextAttemptNo(workDir, el.id)}`,
    inputHash,
    model: el.model,
    requestId: null,
    ...planned,
    durationMs: null,
    state: 'submitting',
    outcome: null,
    reason,
    sourceUrl: null,
    file: null,
    sha256: null,
    uploads: [...refs, ...[frame, end].filter((u) => u !== null)],
    request: req.request,
  };
  await appendSpend(workDir, submitting);
  const requestId = await trySubmit(g, req, params);
  if (typeof requestId !== 'string') return resultOf(submitting, requestId);
  const sent: SpendLine = { ...submitting, at: g.now().toISOString(), state: 'sent', requestId };
  try {
    await appendSpend(workDir, sent);
  } catch (e) {
    // The request is out and paid for; the id rides on the error so `resolve --request-id` can record it.
    throw withDetails(e, { attempt: sent.attempt, requestId });
  }
  return settleLocked(g, { attempt: sent.attempt, element: el.id, last: sent, lines: [submitting, sent] });
}

export function generateElement(g: GenCtx, elementId: string, reason: string | null): Promise<AttemptResult> {
  return withWorkLock(g.ctx.workDir, () => generateLocked(g, elementId, reason));
}

// A later `status` settles what was sent, whatever the brief says now. An unknown model still throws, and the
// attempt stays sent (counted at its estimate) rather than settle on a guess.
const pinnedOf = (ctx: BriefCtx, sent: SpendLine): Pinned => pinned(modelOf(ctx, sent.model), sent.request);

// The price the attempt was sent at, pinned on its lines: an estimate written after the send was never approved for
// this request, so settling never reads one.
function pinnedPrice(sent: SpendLine): Price {
  const unitSize = BigInt(sent.unitSize);
  if (unitSize === 0n) {
    throw new StudioError('UNEXPECTED', `${sent.attempt} has unit size 0`, { attempt: sent.attempt });
  }
  return { unitPriceMicros: parseMicros(sent.unitPriceMicros), unitSize };
}

function requestIdOf(sent: SpendLine): string {
  if (sent.requestId === null) {
    throw new StudioError('UNEXPECTED', `${sent.attempt} has no request id`, { attempt: sent.attempt });
  }
  return sent.requestId;
}

async function pollOnce(g: SettleCtx, p: Pinned, sent: SpendLine): Promise<Polled | null> {
  let status: ProviderStatus;
  try {
    status = await g.provider.status(p.model.endpoint, requestIdOf(sent));
  } catch (e) {
    return openOf(e);
  }
  if (status.state === 'completed') return { kind: 'completed' };
  return status.state === 'failed' ? { kind: 'failed', error: status.error } : null;
}

// Polls at least once, so a later `status` still learns a result that arrived after the limit.
async function waitDone(g: SettleCtx, p: Pinned, sent: SpendLine): Promise<Polled> {
  const deadline = Date.parse(sent.at) + WAIT_LIMIT_MS[p.request.output];
  let polled = await pollOnce(g, p, sent);
  while (polled === null && g.now().getTime() <= deadline) {
    await g.sleep(g.pollMs);
    polled = await pollOnce(g, p, sent);
  }
  // Nothing was thrown, so there is no cause to keep.
  return polled ?? { kind: 'open', error: 'WAIT_TIMEOUT', cause: null };
}

// The table lacks only sizes nobody asked for; such a probed size leaves the request to set the quantity.
function probedQuantity(model: ModelEntry, r: BillingRequest): bigint | null {
  try {
    return billingQuantity(model, r);
  } catch (e) {
    if (e instanceof StudioError) return null;
    throw e;
  }
}

// Billed on the requested duration, never the probed one, which may run up to the tolerance past it. A probed size
// bills only when it comes to more than the request: a smaller file is no sign the provider billed less than asked.
function computedQuantity(p: Pinned, sent: SpendLine, probed: Size | null): bigint {
  const { w, h, durationMs, promptBytes } = p.request;
  const refs = p.request.output === 'image' ? sent.uploads.length : 0;
  const asked: BillingRequest = { w, h, durationMs, fps: p.model.fps, refs, promptBytes };
  let quantity: bigint;
  try {
    quantity = billingQuantity(p.model, asked);
  } catch (e) {
    throw withDetails(e, { attempt: sent.attempt });
  }
  const atProbed = probed === null ? null : probedQuantity(p.model, { ...asked, ...probed });
  return atProbed !== null && atProbed > quantity ? atProbed : quantity;
}

function billedOf(p: Pinned, sent: SpendLine, price: Price, usage: ProviderUsage | null, probed: Size | null): Billed {
  const sameUnit = usage !== null && usage.unit === p.model.billing.unit && CANONICAL_INT.test(usage.quantity);
  const computed = computedQuantity(p, sent, probed);
  // A usage below the request cannot be told from one that counts only part of it, so it never lowers the amount.
  const reported = sameUnit ? BigInt(usage.quantity) : null;
  const byProvider = reported !== null && reported > computed;
  const quantity = byProvider ? reported : computed;
  const amountMicros = lineAmount(price.unitPriceMicros, quantity, price.unitSize).toString();
  return {
    unit: sent.unit,
    quantity: quantity.toString(),
    amountMicros,
    amountBasis: byProvider ? 'provider' : 'computed',
  };
}

const NO_FILE = { sourceUrl: null, file: null, sha256: null } as const;

// A refusal follows the same money rule as a failure; only its outcome differs, so its input is not sent again.
function failedOf(
  p: Pinned,
  sent: SpendLine,
  price: Price,
  error: string | null,
  outcome: 'provider_failed' | 'refused',
): Settlement {
  const billed: Billed = FAILED_REQUEST_BILLED
    ? billedOf(p, sent, price, null, null)
    : { unit: sent.unit, quantity: '0', amountMicros: '0', amountBasis: 'computed' };
  const reason = error === null || error === '' ? 'the provider reported the request failed' : error;
  return { ...billed, outcome, reason: reason.slice(0, REASON_MAX), ...NO_FILE };
}

function extOf(f: ResultFile): string {
  const byType = f.contentType === null ? undefined : EXT_BY_TYPE.get(f.contentType);
  if (byType !== undefined) return byType;
  const fromUrl = URL.canParse(f.url) ? extname(new URL(f.url).pathname).slice(1) : '';
  return KNOWN_EXT.has(fromUrl) ? fromUrl : 'bin';
}

async function probedSize(file: string): Promise<Size | null> {
  try {
    const info = await probe(file);
    return info.hasVideo ? { w: info.width, h: info.height } : null;
  } catch {
    return null;
  }
}

async function completedOf(g: SettleCtx, p: Pinned, sent: SpendLine, price: Price): Promise<Settlement | Open> {
  let result: ProviderResult;
  try {
    result = await g.provider.result(p.model.endpoint, requestIdOf(sent));
  } catch (e) {
    return openOf(e);
  }
  if (result.state === 'refused') return failedOf(p, sent, price, result.error, 'refused');
  const [only, ...more] = result.files;
  if (only === undefined || more.length > 0) {
    const reason = `expected one file, got ${result.files.length}`;
    return { ...billedOf(p, sent, price, result.usage, null), outcome: 'rejected', reason, ...NO_FILE };
  }
  const file = `raw/${sent.element}/${sent.attempt.slice(sent.attempt.lastIndexOf('/') + 1)}.${extOf(only)}`;
  const abs = join(g.ctx.workDir, file);
  let sha256: string;
  try {
    sha256 = await downloadChecked(g.provider, only.url, abs, DOWNLOAD_LIMIT_BYTES[p.request.output]);
  } catch (e) {
    return { kind: 'open', error: 'DOWNLOAD_REJECTED', cause: causeOf(e) };
  }
  const verdict = await checkRaw(abs, p.expect, p.request.follows);
  const billed = billedOf(p, sent, price, result.usage, await probedSize(abs));
  const reason = verdict.ok ? sent.reason : verdict.reason;
  return {
    ...billed,
    outcome: verdict.ok ? 'accepted' : 'rejected',
    reason,
    sourceUrl: only.url,
    file,
    sha256,
  };
}

async function settleLocked(g: SettleCtx, view: AttemptView): Promise<AttemptResult> {
  const sent = view.last;
  let p: Pinned;
  try {
    p = pinnedOf(g.ctx, sent);
  } catch (e) {
    throw withDetails(e, { attempt: sent.attempt });
  }
  const price = pinnedPrice(sent);
  const polled = await waitDone(g, p, sent);
  if (polled.kind === 'open') return resultOf(sent, polled);
  const done =
    polled.kind === 'failed'
      ? failedOf(p, sent, price, polled.error, 'provider_failed')
      : await completedOf(g, p, sent, price);
  if ('kind' in done) return resultOf(sent, done);
  const startedAt = Date.parse((view.lines[0] ?? sent).at);
  const now = g.now();
  const durationMs = Math.max(0, now.getTime() - startedAt);
  const settled: SpendLine = { ...sent, ...done, at: now.toISOString(), state: 'settled', durationMs };
  await appendSpend(g.ctx.workDir, settled);
  return resultOf(settled, null);
}

export function settleSent(g: SettleCtx, view: AttemptView): Promise<AttemptResult> {
  return withWorkLock(g.ctx.workDir, async () => {
    const fresh = (await attempts(g.ctx.workDir)).find((v) => v.attempt === view.attempt);
    if (fresh === undefined)
      throw new StudioError('NOT_FOUND', `no attempt ${view.attempt}`, { attempt: view.attempt });
    if (fresh.last.state === 'settled') return resultOf(fresh.last, null);
    if (fresh.last.state === 'submitting') {
      throw new StudioError('ATTEMPT_UNRESOLVED', `${fresh.attempt} has no request id; check the console and resolve`, {
        attempt: fresh.attempt,
        state: fresh.last.state,
      });
    }
    return settleLocked(g, fresh);
  });
}

export function resolveSubmitting(
  workDir: string,
  attempt: string,
  r: { notSent: true } | { requestId: string },
): Promise<void> {
  return withWorkLock(workDir, async () => {
    const view = (await attempts(workDir)).find((v) => v.attempt === attempt);
    if (view === undefined) throw new StudioError('NOT_FOUND', `no attempt ${attempt}`, { attempt });
    if (view.last.state !== 'submitting') {
      throw new StudioError('USAGE', `${attempt} is ${view.last.state}; only a submitting attempt is resolved`, {
        attempt,
        state: view.last.state,
      });
    }
    const at = new Date().toISOString();
    const next: SpendLine =
      'notSent' in r
        ? {
            ...view.last,
            at,
            state: 'settled',
            outcome: 'not_sent',
            quantity: '0',
            amountMicros: '0',
            amountBasis: 'computed',
          }
        : { ...view.last, at, state: 'sent', requestId: r.requestId };
    await appendSpend(workDir, next);
  });
}

const FAILED_BY_HAND = 'closed by resolve --failed after the user checked the provider console: no result to fetch';

// Run only after the user found no usable result in the console. Nothing is asked or sent; the attempt keeps the estimate
// it was counted at, so the cap never reads less than may have been billed.
export function resolveFailed(workDir: string, attempt: string): Promise<void> {
  return withWorkLock(workDir, async () => {
    const view = (await attempts(workDir)).find((v) => v.attempt === attempt);
    if (view === undefined) throw new StudioError('NOT_FOUND', `no attempt ${attempt}`, { attempt });
    if (view.last.state === 'settled') {
      throw new StudioError('USAGE', `${attempt} is already settled; only an unresolved attempt is closed`, {
        attempt,
        state: view.last.state,
      });
    }
    await appendSpend(workDir, {
      ...view.last,
      at: new Date().toISOString(),
      state: 'settled',
      outcome: 'provider_failed',
      amountBasis: 'estimate',
      reason: FAILED_BY_HAND,
    });
  });
}

// "unconfirmed" covers a keyframe made in this call: the user has to see it before its video is paid for. A given file
// has no keyframe to review.
async function keyframeState(g: GenCtx, video: GenerateVideo, made: ReadonlySet<string>) {
  if (video.from === undefined) return 'ready';
  const accepted = await acceptedKeyframe(g, await attempts(g.ctx.workDir), video.from);
  const sha = accepted?.last.sha256 ?? null;
  if (sha === null) return 'missing';
  const confirmed = (await confirmedKeyframeShas(g.ctx.workDir)).has(sha);
  return confirmed && !made.has(video.from) ? 'ready' : 'unconfirmed';
}

async function nextStep(g: GenCtx, made: ReadonlySet<string>): Promise<Next> {
  const pending = await pendingOf(g.ctx, g.brief, await attempts(g.ctx.workDir));
  if (pending.length === 0) return 'make';
  for (const { el } of pending) {
    if (el.output === 'video' && (await keyframeState(g, el, made)) === 'unconfirmed') return 'keyframe_review';
  }
  return 'nothing';
}

// The pending list is read outside the lock, so another run may have finished the element since; checked again under
// the lock, it is not paid for twice.
function generateIfPending(g: GenCtx, el: Generated): Promise<AttemptResult | null> {
  return withWorkLock(g.ctx.workDir, async () => {
    const views = await attempts(g.ctx.workDir);
    const inputHash = await elementInputHash(g.ctx, g.brief, el.id);
    if (acceptedOf(views, el.id, inputHash) !== null) return null;
    // An open attempt may still bring a paid result, so it stops the run as before, ahead of any older failure.
    refuseUnresolved(views, el.id);
    const last = lastSettledOf(views, el.id, inputHash)?.last ?? null;
    if (last !== null && FAILED_OUTCOMES.has(last.outcome)) {
      return resultOf(last, { error: 'LAST_ATTEMPT_FAILED', cause: last.reason });
    }
    return generateLocked(g, el.id, null);
  });
}

// Pushes into `results` as it goes, so the caller still has them when a later element throws.
async function makePending(g: GenCtx, results: AttemptResult[]): Promise<ReadonlySet<string>> {
  const pending = await pendingOf(g.ctx, g.brief, await attempts(g.ctx.workDir));
  const order = [...pending.filter((p) => p.el.output === 'image'), ...pending.filter((p) => p.el.output === 'video')];
  const made = new Set<string>();
  for (const { el } of order) {
    if (el.output === 'video' && (await keyframeState(g, el, made)) !== 'ready') continue;
    const result = await generateIfPending(g, el);
    if (result === null) continue;
    results.push(result);
    // Nothing was sent for it, so the elements after it go on.
    if (result.error === 'LAST_ATTEMPT_FAILED') continue;
    made.add(el.id);
    // An unresolved attempt may already have cost money; nothing more is sent until status settles it.
    if (result.error !== null) break;
  }
  return made;
}

export async function generatePending(g: GenCtx): Promise<{ results: AttemptResult[]; next: Next }> {
  const results: AttemptResult[] = [];
  try {
    const made = await makePending(g, results);
    return { results, next: await nextStep(g, made) };
  } catch (e) {
    throw carrying(e, results);
  }
}

// Every sent attempt of the work, never re-sending; a submitting one has no request id and waits for resolve.
export async function settleAllSent(g: SettleCtx): Promise<AttemptResult[]> {
  const results: AttemptResult[] = [];
  try {
    for (const view of await attempts(g.ctx.workDir)) {
      if (view.last.state === 'sent') results.push(await settleSent(g, view));
    }
  } catch (e) {
    throw carrying(e, results);
  }
  return results;
}
