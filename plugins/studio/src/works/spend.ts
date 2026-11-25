import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { StudioError } from '../errors.ts';
import { type Micros, parseMicros, toMicros } from '../money/index.ts';
import { HashString, Instant, IntString, ModeSchema } from './estimate.ts';
import { appendJsonl, readJsonl } from './files.ts';

const SPEND_FILE = 'spend.jsonl';

const Id = z.string().min(1);
const Text = z.string().min(1);
const Px = z.int().positive();
const Pair = z.tuple([Px, Px]);
const PromptBytes = z.int().nonnegative();
// The keyframe size and the same-params rows, when the output ratio follows the first frame.
const Follows = z.strictObject({ keyframe: Pair, rows: z.array(Pair) }).nullable();

// What was sent, pinned on every line of the attempt: settling reads this, never a brief edited since.
const SentRequestSchema = z.discriminatedUnion('output', [
  z.strictObject({
    output: z.literal('image'),
    w: Px,
    h: Px,
    durationMs: z.null(),
    promptBytes: PromptBytes,
    follows: Follows,
  }),
  z.strictObject({
    output: z.literal('video'),
    w: Px,
    h: Px,
    durationMs: Px,
    promptBytes: PromptBytes,
    follows: Follows,
  }),
]);

export const SpendLineSchema = z.strictObject({
  schema: z.literal(1),
  at: Instant,
  mode: ModeSchema,
  work: Id,
  element: Id,
  attempt: Id,
  inputHash: HashString,
  model: Id,
  requestId: Id.nullable(),
  unit: Id,
  // The approved price the attempt was sent at; settling bills with these, never with an estimate written since.
  unitPriceMicros: IntString,
  unitSize: IntString,
  quantity: IntString,
  amountMicros: IntString,
  amountBasis: z.enum(['provider', 'computed', 'estimate']),
  durationMs: z.int().nonnegative().nullable(),
  state: z.enum(['submitting', 'sent', 'settled']),
  // refused: the provider declined the input itself. Billed as provider_failed is, but kept apart so the same input
  // is never sent again.
  outcome: z.enum(['accepted', 'rejected', 'provider_failed', 'refused', 'not_sent']).nullable(),
  reason: Text.nullable(),
  sourceUrl: z.url().nullable(),
  file: Text.nullable(),
  sha256: HashString.nullable(),
  uploads: z.array(z.strictObject({ path: Text, url: z.url(), sha256: HashString })),
  request: SentRequestSchema,
});

export type SpendLine = z.infer<typeof SpendLineSchema>;
export type SentRequest = SpendLine['request'];
export type SpendState = SpendLine['state'];
export type Outcome = NonNullable<SpendLine['outcome']>;
export type AttemptView = { attempt: string; element: string; last: SpendLine; lines: SpendLine[] };

const POSITIVE_INT = /^[1-9][0-9]*$/;
// What the attempt sent and is billed in and at; settling reads these from the line, so no later line may change them.
const SHARED = [
  'mode',
  'work',
  'element',
  'inputHash',
  'model',
  'unit',
  'unitPriceMicros',
  'unitSize',
  'uploads',
  'request',
] as const;
const SENT_OUTCOMES: ReadonlySet<Outcome | null> = new Set(['accepted', 'rejected', 'provider_failed', 'refused']);

function sentProblem(prev: SpendLine, next: SpendLine): string | null {
  if (next.requestId === null) return 'a sent line needs the request id';
  // Until settled, an attempt counts at its approved estimate; a sent line may not re-price it.
  const same = next.amountMicros === prev.amountMicros && next.quantity === prev.quantity;
  if (!same || prev.amountBasis !== 'estimate' || next.amountBasis !== 'estimate') {
    return 'a sent line keeps the submitting estimate amount and quantity';
  }
  return null;
}

function settledProblem(next: SpendLine): string | null {
  if (!SENT_OUTCOMES.has(next.outcome))
    return 'a sent attempt settles as accepted, rejected, provider_failed or refused';
  const filed = next.sourceUrl !== null && next.file !== null && next.sha256 !== null;
  return next.outcome === 'accepted' && !filed ? 'an accepted line names its source URL, file and sha256' : null;
}

// The user closes an attempt this way when the console shows no usable result. What it cost is unknown, so it stays
// counted at the estimate it was sent at, the safe side of the cap.
const failedAtEstimate = (next: SpendLine): boolean =>
  next.outcome === 'provider_failed' && next.amountBasis === 'estimate';
const keepsEstimate = (prev: SpendLine, next: SpendLine): boolean =>
  next.amountMicros === prev.amountMicros && next.quantity === prev.quantity;

function sentSettledProblem(prev: SpendLine, next: SpendLine): string | null {
  const problem = settledProblem(next);
  if (problem !== null) return problem;
  if (failedAtEstimate(next) && !keepsEstimate(prev, next)) {
    return 'a provider_failed line priced by the estimate keeps the sent amount and quantity';
  }
  // The request id is what status asked about, so the settled line has to name that same request.
  return next.requestId === prev.requestId ? null : 'a settled line keeps the request id it was sent as';
}

// Every allowed step from an attempt's last state to the next line; a missing pair is not allowed at all.
const STEPS: Partial<Record<`${SpendState}>${SpendState}`, (prev: SpendLine, next: SpendLine) => string | null>> = {
  'submitting>sent': sentProblem,
  'submitting>settled': (prev, next) =>
    (next.outcome === 'not_sent' && next.amountMicros === '0') || (failedAtEstimate(next) && keepsEstimate(prev, next))
      ? null
      : 'an attempt with no request id settles only as not_sent with amount 0 or provider_failed at its estimate',
  'sent>settled': sentSettledProblem,
};

const spendFile = (workDir: string): string => join(workDir, SPEND_FILE);

function broken(line: SpendLine, reason: string): StudioError {
  return new StudioError('UNEXPECTED', `spend line ${line.attempt} breaks the attempt rules: ${reason}`, {
    attempt: line.attempt,
    state: line.state,
    reason,
  });
}

// Null unless the id is `<work>/<element>/<n>` for the line's own work and element.
function attemptNo(line: SpendLine): number | null {
  const prefix = `${line.work}/${line.element}/`;
  const tail = line.attempt.startsWith(prefix) ? line.attempt.slice(prefix.length) : '';
  const n = Number.parseInt(tail, 10);
  return POSITIVE_INT.test(tail) && Number.isSafeInteger(n) ? n : null;
}

function checkOwn(line: SpendLine): void {
  if (attemptNo(line) === null) throw broken(line, 'attempt must be <work>/<element>/<positive integer>');
  if ((line.state === 'settled') !== (line.outcome !== null)) throw broken(line, 'only a settled line has an outcome');
  if (line.state === 'submitting' && line.requestId !== null) throw broken(line, 'a submitting line has no request id');
}

// Defence in depth: the generate flow checks this first, but no path may resend while an attempt is unresolved.
function checkFirst(views: readonly AttemptView[], line: SpendLine): void {
  if (line.state !== 'submitting') throw broken(line, 'an attempt starts with submitting');
  if (line.amountBasis !== 'estimate') throw broken(line, 'a submitting line is priced by the estimate');
  const open = unresolvedOf(views, line.element);
  if (open !== null) {
    throw new StudioError('ATTEMPT_UNRESOLVED', `${line.element} has an unresolved attempt ${open.attempt}`, {
      element: line.element,
      attempt: open.attempt,
      state: open.last.state,
    });
  }
}

function checkNext(view: AttemptView, line: SpendLine): void {
  const changed = SHARED.find((k) => view.lines.some((l) => !isDeepStrictEqual(l[k], line[k])));
  if (changed !== undefined) throw broken(line, `${changed} differs from the attempt's earlier lines`);
  const step = STEPS[`${view.last.state}>${line.state}`];
  if (step === undefined) throw broken(line, `${view.last.state} cannot be followed by ${line.state}`);
  const problem = step(view.last, line);
  if (problem !== null) throw broken(line, problem);
}

// One request is paid once: a second attempt naming it would count its money twice and take its file.
function checkRequestId(views: readonly AttemptView[], line: SpendLine): void {
  if (line.requestId === null) return;
  const other = views.find((v) => v.attempt !== line.attempt && v.lines.some((l) => l.requestId === line.requestId));
  if (other !== undefined) throw broken(line, `request id ${line.requestId} already belongs to ${other.attempt}`);
}

// Callers hold the work lock, so the file read here is still the file the line is appended to.
export async function appendSpend(workDir: string, line: SpendLine): Promise<void> {
  checkOwn(line);
  const views = await attempts(workDir);
  checkRequestId(views, line);
  const view = views.find((v) => v.attempt === line.attempt);
  if (view === undefined) checkFirst(views, line);
  else checkNext(view, line);
  await appendJsonl(spendFile(workDir), SpendLineSchema, line);
}

// Read without locking the other works: lines are only ever appended, so an id once written stays where it is. A folder
// without a spend file has spent nothing; any other read failure throws, since it may hide the id.
export async function requestIdOwner(worksRoot: string, requestId: string): Promise<string | null> {
  for (const entry of await readdir(worksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const lines = await readJsonl(spendFile(join(worksRoot, entry.name)), SpendLineSchema);
    const owner = lines.find((l) => l.requestId === requestId);
    if (owner !== undefined) return owner.attempt;
  }
  return null;
}

export async function attempts(workDir: string): Promise<AttemptView[]> {
  const views = new Map<string, AttemptView>();
  for (const line of await readJsonl(spendFile(workDir), SpendLineSchema)) {
    const view = views.get(line.attempt);
    if (view === undefined) {
      views.set(line.attempt, { attempt: line.attempt, element: line.element, last: line, lines: [line] });
    } else {
      view.lines.push(line);
      view.last = line;
    }
  }
  return [...views.values()];
}

// The only place work spend is summed. An unsettled attempt counts at its estimate so spend is never under-read.
export async function workSpend(workDir: string): Promise<Micros> {
  let total = 0n;
  for (const view of await attempts(workDir)) total += parseMicros(view.last.amountMicros);
  return toMicros(total);
}

export async function nextAttemptNo(workDir: string, element: string): Promise<number> {
  let highest = 0;
  for (const view of await attempts(workDir)) {
    if (view.element !== element) continue;
    const n = attemptNo(view.last);
    if (n === null) throw broken(view.last, 'attempt must be <work>/<element>/<positive integer>');
    highest = Math.max(highest, n);
  }
  return highest + 1;
}

export function unresolvedOf(views: readonly AttemptView[], element: string): AttemptView | null {
  return views.find((v) => v.element === element && v.last.state !== 'settled') ?? null;
}

const isAccepted = (v: AttemptView): boolean => v.last.state === 'settled' && v.last.outcome === 'accepted';

export function acceptedOf(views: readonly AttemptView[], element: string, inputHash: string): AttemptView | null {
  return views.findLast((v) => v.element === element && isAccepted(v) && v.last.inputHash === inputHash) ?? null;
}
