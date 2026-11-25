import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Mode } from '../config.ts';
import { StudioError } from '../errors.ts';
import { renderLayoutRef } from '../make/index.ts';
import { capOf, formatUsd, type Micros, parseMicros, toMicros } from '../money/index.ts';
import {
  type AttemptView,
  acceptedOf,
  attempts,
  type Brief,
  type BriefCtx,
  type Estimate,
  type EstimateLine,
  EstimateSchema,
  elementInputHash,
  elementSize,
  type GenerateImage,
  type GenerateVideo,
  isAllowed,
  type ModelEntry,
  type ResolvedSize,
  type Stated,
  sha256File,
  videoFpsIssue,
  workSpend,
} from '../works/index.ts';
import { billingQuantity, lineAmount, pricedSize, statedUsdAt, unitPriceOf } from './pricing.ts';
import type { PriceQuote, Provider } from './provider.ts';

const MARGIN_RATE = '0.2';
const PRICE_SOURCE: Record<Mode, string> = { live: 'pricing-api', fake: 'fake' };

type Generated = GenerateImage | GenerateVideo;
type Pending = { el: Generated; model: ModelEntry; dependsOn: string | null };
type Quotes = { byEndpoint: ReadonlyMap<string, PriceQuote>; received: readonly PriceQuote[] };

async function isDone(ctx: BriefCtx, brief: Brief, views: readonly AttemptView[], id: string): Promise<boolean> {
  return acceptedOf(views, id, await elementInputHash(ctx, brief, id)) !== null;
}

function modelFor(ctx: BriefCtx, el: Generated): ModelEntry {
  const m = ctx.models.get(el.model);
  if (m === undefined) {
    throw new StudioError('UNEXPECTED', `${el.id} names unknown model ${el.model}`, {
      element: el.id,
      model: el.model,
    });
  }
  return m;
}

// A video's fingerprint hashes its accepted keyframe file, so while the keyframe is not done the video cannot be
// fingerprinted yet; it is pending on that keyframe instead. A video on a given file has no keyframe to wait on.
// Generate makes exactly what this lists.
export async function pendingOf(ctx: BriefCtx, brief: Brief, views: readonly AttemptView[]): Promise<Pending[]> {
  const pending: Pending[] = [];
  for (const el of brief.elements) {
    if (el.method !== 'generate') continue;
    if (el.output === 'video' && el.from !== undefined && !(await isDone(ctx, brief, views, el.from))) {
      pending.push({ el, model: modelFor(ctx, el), dependsOn: el.from });
    } else if (!(await isDone(ctx, brief, views, el.id))) {
      pending.push({ el, model: modelFor(ctx, el), dependsOn: null });
    }
  }
  return pending;
}

const GUIDE_STALE = 'the layout guide is older than the brief; run preview again';

async function guideOnDisk(ctx: BriefCtx, id: string): Promise<string | null> {
  try {
    return await sha256File(join(ctx.workDir, 'preview', `ref-${id}.png`));
  } catch (e) {
    if (e instanceof StudioError && e.code === 'NOT_FOUND') return null;
    throw e;
  }
}

// Only preview writes the guide, and one brief always draws the same bytes, so a file that differs was drawn from an
// earlier brief and would send the old composition. A missing file is left to the fingerprint's "run preview first".
export async function refuseStaleGuide(ctx: BriefCtx, brief: Brief, id: string): Promise<void> {
  const index = brief.elements.findIndex((e) => e.id === id);
  const el = brief.elements[index];
  if (el?.method !== 'generate' || el.output !== 'image' || el.layoutRef !== true) return;
  const onDisk = await guideOnDisk(ctx, id);
  if (onDisk === null) return;
  const drawn = `sha256:${createHash('sha256')
    .update(await renderLayoutRef(brief, id))
    .digest('hex')}`;
  if (drawn === onDisk) return;
  throw new StudioError('BRIEF_INVALID', GUIDE_STALE, {
    issues: [{ path: `elements.${index}.layoutRef`, code: 'BRIEF_INVALID', reason: GUIDE_STALE }],
  });
}

async function quotesFor(provider: Provider, models: readonly ModelEntry[]): Promise<Quotes> {
  const endpoints = [...new Set(models.map((m) => m.endpoint))];
  if (endpoints.length === 0) return { byEndpoint: new Map(), received: [] };
  const received = await provider.price(endpoints);
  const quotes = new Map<string, PriceQuote>();
  for (const q of received) {
    // Two prices for one endpoint (e.g. input and output tokens) leave the billed one unknown; guessing could go low.
    if (quotes.has(q.endpoint)) {
      throw badQuote(
        q.endpoint,
        'quote',
        'duplicate',
        received.filter((r) => r.endpoint === q.endpoint),
      );
    }
    quotes.set(q.endpoint, q);
  }
  return { byEndpoint: quotes, received };
}

// The quotes as received go into details, so a unit the model list does not expect is fixed in one data edit.
function badQuote(endpoint: string, field: string, got: string | null, received: readonly PriceQuote[]): StudioError {
  const what = got === null ? `no price for ${endpoint}` : `price for ${endpoint} has ${field} ${JSON.stringify(got)}`;
  const stated = received.map((q) => ({
    endpoint: q.endpoint,
    unit: q.unit,
    unitPriceUsd: q.unitPriceUsd,
    currency: q.currency,
  }));
  return new StudioError('PROVIDER_ERROR', what, { endpoint, field, got, received: stated });
}

function readPrice(m: ModelEntry, quote: PriceQuote): { unitPriceMicros: Micros; unitSize: bigint } {
  try {
    return unitPriceOf(m, quote.unitPriceUsd);
  } catch (e) {
    if (e instanceof RangeError) throw badQuote(m.endpoint, 'unitPriceUsd', quote.unitPriceUsd, [quote]);
    throw e;
  }
}

type Price = { unitPriceMicros: Micros; unitSize: bigint; stated: Stated | null };

// What the pricing API answers instead of a price for some endpoints (token-priced images, 2026-10-30). Only this
// exact answer hands over to a stated price; any other unknown answer still stops, so a changed placeholder shows.
const PLACEHOLDER = { unit: 'units', unitPriceUsd: '1' };
const STATED_MAX_AGE_DAYS = 30;
const MS_PER_DAY = 86_400_000;

// Both ends are UTC midnights (a date-only ISO string parses as one), so the difference is whole days.
function daysSince(checkedAt: string, now: Date): number {
  return (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.parse(checkedAt)) / MS_PER_DAY;
}

// A page price is only as good as its last check; an old or future date sends Claude back to the page. Fake mode
// spends nothing and its approvals never reach the live works root, so it prices with the page price whatever its date.
function statedPrice(m: ModelEntry, stated: Stated, size: ResolvedSize, now: Date, checkAge: boolean): Price {
  const age = daysSince(stated.checkedAt, now);
  // Written as the usable range so that a NaN age (an invalid clock) is refused too.
  if (checkAge && !(age >= 0 && age <= STATED_MAX_AGE_DAYS)) {
    throw new StudioError('PROVIDER_ERROR', `stated price for ${m.endpoint} was checked ${stated.checkedAt}`, {
      endpoint: m.endpoint,
      field: 'stated.checkedAt',
      got: stated.checkedAt,
      source: stated.source,
      maxAgeDays: STATED_MAX_AGE_DAYS,
    });
  }
  return { ...unitPriceOf(m, statedUsdAt(m, stated, size)), stated };
}

// Exact cross-multiplication of the two unit prices; a tie keeps the API's, so priceSource names the live answer.
function higher(api: Price, page: Price): Price {
  return page.unitPriceMicros * api.unitSize > api.unitPriceMicros * page.unitSize ? page : api;
}

function priceOf(m: ModelEntry, quotes: Quotes, size: ResolvedSize, now: Date, checkAge: boolean): Price {
  const quote = quotes.byEndpoint.get(m.endpoint);
  // Everything received goes along, so a price answered under another endpoint id shows up beside the missing one.
  if (quote === undefined) throw badQuote(m.endpoint, 'quote', null, quotes.received);
  if (quote.currency !== 'USD') throw badQuote(m.endpoint, 'currency', quote.currency, [quote]);
  const { stated } = m.billing;
  if (quote.unit !== m.billing.unit) {
    const placeholder = quote.unit === PLACEHOLDER.unit && quote.unitPriceUsd === PLACEHOLDER.unitPriceUsd;
    if (placeholder && stated !== undefined) return statedPrice(m, stated, size, now, checkAge);
    throw badQuote(m.endpoint, 'unit', quote.unit, [quote]);
  }
  const price = readPrice(m, quote);
  // No generation is free: a zero price makes a zero line and a zero cap, which would bound no retry at all.
  if (price.unitPriceMicros === 0n) throw badQuote(m.endpoint, 'unitPriceUsd', quote.unitPriceUsd, [quote]);
  const api: Price = { ...price, stated: null };
  // A per-size page means the API's one price can be below what a larger size bills, so the higher one is taken.
  // A single page price only stands in for the placeholder.
  return stated?.bySize === undefined ? api : higher(api, statedPrice(m, stated, size, now, checkAge));
}

type Priced = { unitPriceMicros: Micros; unitSize: bigint; quantity: bigint; amount: Micros; stated: Stated | null };

// The one reading of an element's billing inputs. Estimate lines and the smoke pick both price through it, so smoke
// never ranks a model by an amount its estimate line would not have.
function pricedElement(
  model: ModelEntry,
  el: Generated,
  size: ResolvedSize,
  quotes: Quotes,
  now: Date,
  checkAge: boolean,
): Priced {
  const { unitPriceMicros, unitSize, stated } = priceOf(model, quotes, size, now, checkAge);
  const { w, h } = pricedSize(model, size);
  const quantity = billingQuantity(model, {
    w,
    h,
    durationMs: el.output === 'video' ? el.durationMs : null,
    fps: model.fps,
    refs: el.output === 'image' ? (el.refs?.length ?? 0) + (el.layoutRef === true ? 1 : 0) : 0,
    promptBytes: Buffer.byteLength(el.prompt, 'utf8'),
  });
  return { unitPriceMicros, unitSize, quantity, amount: lineAmount(unitPriceMicros, quantity, unitSize), stated };
}

function lineOf(
  ctx: BriefCtx,
  brief: Brief,
  p: Pending,
  quotes: Quotes,
  source: string,
  now: Date,
  checkAge: boolean,
): EstimateLine {
  const { el, model } = p;
  const priced = pricedElement(model, el, elementSize(ctx, brief, el.id), quotes, now, checkAge);
  const { stated } = priced;
  return {
    element: el.id,
    model: el.model,
    unit: model.billing.unit,
    unitSize: priced.unitSize.toString(),
    unitPriceMicros: priced.unitPriceMicros.toString(),
    quantity: priced.quantity.toString(),
    amountMicros: priced.amount.toString(),
    priceSource: stated === null ? source : `stated-price ${stated.checkedAt} ${stated.source}`,
    dependsOn: p.dependsOn,
  };
}

function checked(estimate: Estimate): Estimate {
  const parsed = EstimateSchema.safeParse(estimate);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => ({
    path: i.path.map((seg) => String(seg)).join('.'),
    message: i.message,
  }));
  throw new StudioError('UNEXPECTED', 'the built estimate does not match its schema', { issues });
}

// `briefHash` names the bytes `brief` was parsed from (loadBriefHashed); re-reading the file here, after the
// network call, could pair these lines with a brief edited in between.
export async function buildEstimate(a: {
  ctx: BriefCtx;
  brief: Brief;
  briefHash: string;
  provider: Provider;
  mode: Mode;
  now: Date;
}): Promise<Estimate> {
  const { ctx, brief } = a;
  const fpsIssue = videoFpsIssue(brief, ctx.models);
  if (fpsIssue !== null) throw new StudioError('BRIEF_INVALID', fpsIssue.reason, { issues: [fpsIssue] });
  // Every guide, finished elements too: one made from an old guide still reads as done until preview redraws it.
  for (const el of brief.elements) await refuseStaleGuide(ctx, brief, el.id);
  const pending = await pendingOf(ctx, brief, await attempts(ctx.workDir));
  const quotes = await quotesFor(
    a.provider,
    pending.map((p) => p.model),
  );
  const createdAt = a.now.toISOString();
  const source = `${PRICE_SOURCE[a.mode]} ${createdAt}`;
  const checkAge = a.mode === 'live';
  const lines = pending.map((p) => lineOf(ctx, brief, p, quotes, source, a.now, checkAge));
  const spend = await workSpend(ctx.workDir);
  let total: bigint = spend;
  for (const l of lines) total += parseMicros(l.amountMicros);
  const subtotal = toMicros(total);
  return checked({
    schema: 1,
    mode: a.mode,
    briefHash: a.briefHash,
    createdAt,
    lines,
    spendMicros: spend.toString(),
    subtotalMicros: subtotal.toString(),
    marginRate: MARGIN_RATE,
    capMicros: capOf(subtotal, MARGIN_RATE).toString(),
  });
}

function lineAmountOf(amounts: ReadonlyMap<string, Micros>, element: string, from: string): Micros {
  const amount = amounts.get(element);
  if (amount === undefined) {
    throw new StudioError('UNEXPECTED', `estimate line ${from} depends on ${element}, which has no line`, {
      element: from,
      dependsOn: element,
    });
  }
  return amount;
}

// Removing a video also drops the keyframe it waits on, since that keyframe is only made to open the video.
export function removalSavings(e: Estimate): Record<string, string> {
  const amounts = new Map(e.lines.map((l) => [l.element, parseMicros(l.amountMicros)]));
  return Object.fromEntries(
    e.lines.map((l) => {
      const own = lineAmountOf(amounts, l.element, l.element);
      const keyframe = l.dependsOn === null ? 0n : lineAmountOf(amounts, l.dependsOn, l.element);
      return [l.element, (own + keyframe).toString()];
    }),
  );
}

const usd = (micros: string): string => formatUsd(parseMicros(micros));

// Display only: what Claude reads out to the user. Every decision uses the μUSD strings, never these.
export function estimateUsd(e: Estimate): {
  spend: string;
  subtotal: string;
  cap: string;
  lines: Record<string, string>;
  removalSavings: Record<string, string>;
} {
  return {
    spend: usd(e.spendMicros),
    subtotal: usd(e.subtotalMicros),
    cap: usd(e.capMicros),
    lines: Object.fromEntries(e.lines.map((l) => [l.element, usd(l.amountMicros)])),
    removalSavings: Object.fromEntries(Object.entries(removalSavings(e)).map(([id, m]) => [id, usd(m)])),
  };
}

// What the smoke element is apart from its model; the pick fills in the model and whether it needs the layout guide.
export type SmokeBase = { id: string; label: string; prompt: string };
// `element` is the brief element exactly as it was priced.
export type SmokeModel = { element: GenerateImage; w: number; h: number; amountMicros: string };
type SmokeCandidate = { model: ModelEntry; size: ResolvedSize; element: GenerateImage };

// A one-image work has at most the layout guide as its reference, so a model that needs more cannot make one.
function smokeCandidate(m: ModelEntry, base: SmokeBase): SmokeCandidate | null {
  const minRefs = m.slots.refs?.min ?? 0;
  if (m.output !== 'image' || !isAllowed(m) || minRefs > 1) return null;
  let smallest: ModelEntry['sizes'][number] | null = null;
  for (const s of m.sizes) if (smallest === null || s.w * s.h < smallest.w * smallest.h) smallest = s;
  if (smallest === null) return null;
  const { id, label, prompt } = base;
  const element: GenerateImage = { id, label, method: 'generate', output: 'image', model: m.id, prompt };
  if (minRefs === 1) element.layoutRef = true;
  return { model: m, size: smallest, element };
}

// Each allowed image model at its smallest size, priced as its estimate line will be; the first listed wins a tie.
// A candidate without a quote fails the pick: skipping it could crown a model that is not the cheapest.
export async function cheapestImageModel(
  models: ReadonlyMap<string, ModelEntry>,
  provider: Provider,
  base: SmokeBase,
  now: Date,
  checkAge: boolean,
): Promise<SmokeModel> {
  const candidates = [...models.values()].flatMap((m) => smokeCandidate(m, base) ?? []);
  const quotes = await quotesFor(
    provider,
    candidates.map((c) => c.model),
  );
  let best: { c: SmokeCandidate; amount: Micros } | null = null;
  for (const c of candidates) {
    const { amount } = pricedElement(c.model, c.element, c.size, quotes, now, checkAge);
    if (best === null || amount < best.amount) best = { c, amount };
  }
  if (best === null) throw new StudioError('NOT_FOUND', 'no allowed image model can make a one-image work', {});
  const { element, size } = best.c;
  return { element, w: size.w, h: size.h, amountMicros: best.amount.toString() };
}
