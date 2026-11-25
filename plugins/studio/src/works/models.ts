import { join } from 'node:path';
import { z } from 'zod';
import { StudioError } from '../errors.ts';
import { toUnitPrice } from '../money/index.ts';
import { type Issue, issueList, readJson, writeJsonAtomic } from './files.ts';

export type Rect = readonly [number, number, number, number];

const Id = z.string().min(1);
const PosInt = z.int().positive();
const NonNegInt = z.int().nonnegative();
const Param = z.union([z.string(), z.number(), z.boolean()]);
const ParamMap = z.record(z.string(), Param);

const Size = z.strictObject({ w: PosInt, h: PosInt, params: ParamMap });
const Duration = z.strictObject({ ms: PosInt, params: ParamMap });
const Slots = z.strictObject({
  prompt: Id,
  refs: z
    .strictObject({ param: Id, min: NonNegInt, max: PosInt })
    .refine((r) => r.min <= r.max, { path: ['min'], message: 'min must not exceed max' })
    .nullable(),
  firstFrame: Id.nullable(),
  lastFrame: Id.nullable(),
});

const Quantity = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('per_image') }),
  z.strictObject({ kind: z.literal('per_second') }),
  z.strictObject({ kind: z.literal('per_megapixel') }),
  z.strictObject({ kind: z.literal('video_tokens'), pixelsPerToken: PosInt }),
  // perRefTokens bounds one reference image, in tokens priced like the output tokens.
  z.strictObject({ kind: z.literal('fixed_tokens'), tokens: PosInt, perRefTokens: NonNegInt }),
  // For models whose output-token count depends on the pixel size (at the quality pinned in fixedParams).
  z.strictObject({
    kind: z.literal('image_tokens'),
    bySize: z.array(z.strictObject({ w: PosInt, h: PosInt, tokens: PosInt })).min(1),
    perRefTokens: NonNegInt,
  }),
]);

// Null for text that is no decimal price, so a list check can skip a value its field check already refused.
function unitPriceOrNull(s: string): ReturnType<typeof toUnitPrice> | null {
  try {
    return toUnitPrice(s);
  } catch (e) {
    if (e instanceof RangeError) return null;
    throw e;
  }
}

function isPositivePrice(s: string): boolean {
  return (unitPriceOrNull(s)?.unitPriceMicros ?? 0n) > 0n;
}

const PositivePrice = z.string().refine(isPositivePrice, { message: 'not a positive decimal price' });

// A price copied from the model page, for an endpoint whose pricing API answers a placeholder instead of a price,
// or one price per size for an endpoint whose API answers a single price below what its larger sizes bill.
const StatedFields = z.strictObject({
  // Repeats billing.unit, so editing one without the other is refused instead of reading the price in a new unit.
  unit: Id,
  unitPriceUsd: PositivePrice.optional(),
  bySize: z
    .array(z.strictObject({ w: PosInt, h: PosInt, unitPriceUsd: PositivePrice }))
    .min(1)
    .optional(),
  checkedAt: z.iso.date(),
  source: z.url(),
});
const onePrice = (s: { unitPriceUsd?: string | undefined; bySize?: unknown }): boolean =>
  (s.unitPriceUsd === undefined) !== (s.bySize === undefined);
const ONE_PRICE = { message: 'give exactly one of unitPriceUsd and bySize' };
const Stated = StatedFields.refine(onePrice, ONE_PRICE);
// A page price as a re-check states it: its date is the day the check is recorded, never taken from input.
export const StatedInput = StatedFields.omit({ checkedAt: true }).refine(onePrice, ONE_PRICE);

type SizeRow = z.infer<typeof Size>;
type StatedRow = { w: number; h: number; unitPriceUsd: string };
type PathOf = (...at: number[]) => (string | number)[];

// A fresh array per issue: Zod prefixes an issue's path in place as it bubbles up, so a shared one would collect them.
const bySizePath: PathOf = (...at) => ['billing', 'stated', 'bySize', ...at];
const quantityPath: PathOf = (...at) => ['billing', 'quantity', 'bySize', ...at];
const sizeKey = (s: { w: number; h: number }): string => `${s.w}x${s.h}`;

export function sameParams(a: z.infer<typeof ParamMap>, b: z.infer<typeof ParamMap>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}

// Exact cross-multiplication; null when either text is no decimal price.
function equalPrices(a: string, b: string): boolean | null {
  const pa = unitPriceOrNull(a);
  const pb = unitPriceOrNull(b);
  if (pa === null || pb === null) return null;
  return pa.unitPriceMicros * pb.unitSize === pb.unitPriceMicros * pa.unitSize;
}

// One row per listed size and no other, so every size the estimate can resolve has exactly one row.
function rowsBySize<T extends { w: number; h: number }>(
  sizes: readonly SizeRow[],
  rows: readonly T[],
  ctx: z.RefinementCtx,
  pathOf: PathOf,
): Map<string, { at: number; row: T }> {
  const listed = new Set(sizes.map(sizeKey));
  const priced = new Map<string, { at: number; row: T }>();
  for (const [at, row] of rows.entries()) {
    const key = sizeKey(row);
    const problem = !listed.has(key) ? `${key} is not in sizes` : priced.has(key) ? `duplicate ${key}` : null;
    if (problem === null) priced.set(key, { at, row });
    else ctx.addIssue({ code: 'custom', path: pathOf(at), message: problem });
  }
  for (const s of sizes) {
    if (!priced.has(sizeKey(s))) ctx.addIssue({ code: 'custom', path: pathOf(), message: `missing ${sizeKey(s)}` });
  }
  return priced;
}

// Rows that send the same params are one request, priced at the largest of them, so their page prices must agree.
function checkStatedRows(sizes: readonly SizeRow[], rows: readonly StatedRow[], ctx: z.RefinementCtx): void {
  const priced = rowsBySize(sizes, rows, ctx, bySizePath);
  for (const s of sizes) {
    const head = sizes.find((t) => sameParams(t.params, s.params)) ?? s;
    const row = priced.get(sizeKey(s));
    const headRow = priced.get(sizeKey(head));
    // A price that does not parse already carries its own issue, so it is not compared.
    if (
      row === undefined ||
      headRow === undefined ||
      equalPrices(row.row.unitPriceUsd, headRow.row.unitPriceUsd) !== false
    )
      continue;
    const message = `${sizeKey(s)} sends the same params as ${sizeKey(head)} at another price`;
    ctx.addIssue({ code: 'custom', path: bySizePath(row.at), message });
  }
}

const Entry = z
  .strictObject({
    id: Id,
    provider: z.literal('fal'),
    endpoint: Id,
    output: z.enum(['image', 'video']),
    use: Id,
    sizes: z.array(Size),
    durations: z.array(Duration),
    fps: PosInt.nullable(),
    audio: z.boolean(),
    slots: Slots,
    fixedParams: ParamMap,
    // How many billed units the quoted price covers, e.g. 1000000 for a price per 1M tokens.
    billing: z.strictObject({ unit: Id, quantityPerUnit: PosInt, quantity: Quantity, stated: Stated.optional() }),
    commercialUse: z.strictObject({ checkedAt: z.iso.date(), source: z.url() }).nullable(),
  })
  .superRefine((m, ctx) => {
    const { stated } = m.billing;
    if (stated !== undefined && stated.unit !== m.billing.unit) {
      ctx.addIssue({ code: 'custom', path: ['billing', 'stated', 'unit'], message: 'must equal billing.unit' });
    }
    if (stated?.bySize !== undefined) checkStatedRows(m.sizes, stated.bySize, ctx);
    if (m.billing.quantity.kind === 'image_tokens') rowsBySize(m.sizes, m.billing.quantity.bySize, ctx, quantityPath);
    if (m.output !== 'image') return;
    if (m.durations.length > 0)
      ctx.addIssue({ code: 'custom', path: ['durations'], message: 'an image has no durations' });
    if (m.fps !== null) ctx.addIssue({ code: 'custom', path: ['fps'], message: 'an image has no fps' });
  });

export const ModelsFile = z.strictObject({ schema: z.literal(1), models: z.array(Entry) }).superRefine((file, ctx) => {
  const seen = new Set<string>();
  for (const [i, m] of file.models.entries()) {
    if (seen.has(m.id)) ctx.addIssue({ code: 'custom', path: ['models', i, 'id'], message: `duplicate id ${m.id}` });
    seen.add(m.id);
  }
});

export type ModelEntry = z.infer<typeof Entry>;
export type Quantity = ModelEntry['billing']['quantity'];
export type Stated = NonNullable<ModelEntry['billing']['stated']>;
export type StatedInput = Omit<Stated, 'checkedAt'>;
export type Params = ModelEntry['fixedParams'];
export type ResolvedSize = { w: number; h: number; params: Params };

type SizeEntry = ModelEntry['sizes'][number];
type RatioGroup = { head: SizeEntry; members: SizeEntry[] };

// Page prices re-checked in the studio folder, by model id: the bundled list cannot be edited where it is installed.
const PRICE_CHECKS_FILE = 'price-checks.json';
const PriceChecksFile = z.strictObject({ schema: z.literal(1), models: z.record(Id, Stated) });
type PriceChecks = z.infer<typeof PriceChecksFile>;

function sameRows(a: readonly StatedRow[], b: readonly StatedRow[]): boolean {
  const prices = new Map(b.map((r) => [sizeKey(r), r.unitPriceUsd]));
  const unique = new Set(a.map(sizeKey)).size === a.length && prices.size === b.length;
  return (
    unique &&
    a.length === b.length &&
    a.every((r) => {
      const price = prices.get(sizeKey(r));
      return price !== undefined && equalPrices(r.unitPriceUsd, price) === true;
    })
  );
}

function bothOrNeither<T>(a: T | undefined, b: T | undefined, same: (x: T, y: T) => boolean): boolean {
  return a === undefined || b === undefined ? a === b : same(a, b);
}

// The same unit and amounts, size by size in any order; the source page can move while the price stays.
export function samePrice(a: StatedInput, b: StatedInput): boolean {
  return (
    a.unit === b.unit &&
    bothOrNeither(a.unitPriceUsd, b.unitPriceUsd, (x, y) => equalPrices(x, y) === true) &&
    bothOrNeither(a.bySize, b.bySize, sameRows)
  );
}

// `stated` in place of the model's page price, checked as the bundled list is. The form stays: a single page price
// only stands in for a placeholder answer while a per-size one is weighed against every answer, so switching forms
// would change how the estimate prices, not only the amount.
export function restate(
  m: ModelEntry,
  stated: Stated,
): { ok: true; model: ModelEntry } | { ok: false; issues: Issue[] } {
  const issues: Issue[] = [];
  const formOf = (s: Stated | undefined): string => (s?.bySize === undefined ? 'unitPriceUsd' : 'bySize');
  const [bundled, given] = [formOf(m.billing.stated), formOf(stated)];
  if (given !== bundled) {
    const message = `${given} in place of the bundled ${bundled} is a change to the model entry, not a price change`;
    issues.push({ path: 'billing.stated', message });
  }
  const parsed = Entry.safeParse({ ...m, billing: { ...m.billing, stated } });
  if (!parsed.success) {
    issues.push(...issueList(parsed.error.issues));
  }
  return parsed.success && issues.length === 0 ? { ok: true, model: parsed.data } : { ok: false, issues };
}

// Past a missing file the record file is at fault: readJson reports a bad JSON or schema as BRIEF_INVALID with
// { file, issues }, and a path it cannot read (a folder, no permission) as the fs error, kept as the cause.
async function readPriceChecks(file: string): Promise<PriceChecks | null> {
  try {
    return await readJson(file, PriceChecksFile);
  } catch (e) {
    if (e instanceof StudioError && e.code === 'NOT_FOUND') return null;
    const why = `${file} is not a valid price-check record`;
    if (e instanceof StudioError && e.code === 'BRIEF_INVALID') throw new StudioError('CONFIG_INVALID', why, e.details);
    const error = new StudioError('CONFIG_INVALID', why, { file });
    error.cause = e;
    throw error;
  }
}

function badCheck(file: string, model: string, why: string, issues: Issue[] = []): StudioError {
  return new StudioError('CONFIG_INVALID', `${file}: the price check for ${model} ${why}`, {
    file,
    model,
    ...(issues.length === 0 ? {} : { issues }),
  });
}

// The entry priced by `record`, or null while the bundled price was checked later. ISO dates order as text. A record
// from the bundled check's own day wins too: a price that changed that day is recorded that day and must be used.
function recordedEntry(m: ModelEntry, page: Stated, record: Stated): ReturnType<typeof restate> | null {
  return record.checkedAt < page.checkedAt ? null : restate(m, record);
}

function applyRecord(models: Map<string, ModelEntry>, file: string, id: string, record: Stated): void {
  const m = models.get(id);
  if (m === undefined) throw badCheck(file, id, 'names no model in the bundled list');
  const page = m.billing.stated;
  if (page === undefined) throw badCheck(file, id, 'is for a model priced by the pricing API');
  const recorded = recordedEntry(m, page, record);
  if (recorded === null) return;
  if (!recorded.ok) {
    const why = `no longer fits the bundled entry; check the page again and run price-check ${id}`;
    throw badCheck(file, id, why, recorded.issues);
  }
  models.set(id, recorded.model);
}

// Every record but `own`'s applied to the bundled entries, and the records as read.
async function loadExcept(
  codeRoot: string,
  home: string,
  own: string | null,
): Promise<{ models: Map<string, ModelEntry>; records: ReadonlyMap<string, Stated> }> {
  const bundled = await readJson(join(codeRoot, 'data', 'models.json'), ModelsFile);
  const models = new Map(bundled.models.map((m) => [m.id, m]));
  const file = join(home, PRICE_CHECKS_FILE);
  // Null is a missing file, which holds no record; any other read failure has thrown.
  const records = new Map(Object.entries((await readPriceChecks(file))?.models ?? {}));
  for (const [id, record] of records) if (id !== own) applyRecord(models, file, id, record);
  return { models, records };
}

export async function loadModels(codeRoot: string, home: string): Promise<ReadonlyMap<string, ModelEntry>> {
  return (await loadExcept(codeRoot, home, null)).models;
}

// For a check of `id`'s page price: `model` is its bundled entry, which the new price is checked against, and `record`
// its own record while that is the price in use. Every other record must still fit, as loadModels requires; `id`'s own
// record that no longer fits is not in use, and only waits for this check to replace it.
export async function loadForPriceCheck(
  codeRoot: string,
  home: string,
  id: string,
): Promise<{ model: ModelEntry | undefined; record: Stated | null }> {
  const { models, records } = await loadExcept(codeRoot, home, id);
  const model = models.get(id);
  const page = model?.billing.stated;
  const record = records.get(id);
  if (model === undefined || page === undefined || record === undefined) return { model, record: null };
  return { model, record: recordedEntry(model, page, record)?.ok === true ? record : null };
}

// The whole file is rewritten so the other models' checks stay; a broken file stops the write instead of being lost.
// The caller holds the studio-folder lock (withWorkLock(home)) from its read of the price in use to this write, so
// another check can neither drop this model's record nor change the price this one was compared with.
export async function recordPriceCheck(home: string, id: string, stated: Stated): Promise<string> {
  const file = join(home, PRICE_CHECKS_FILE);
  const checks = await readPriceChecks(file);
  await writeJsonAtomic(file, PriceChecksFile, { schema: 1, models: { ...checks?.models, [id]: stated } });
  return file;
}

export function isAllowed(m: ModelEntry): boolean {
  return m.commercialUse !== null;
}

// Exact cross-multiplication: float ratios would split 1920:1080 from 16:9 on rounding noise.
function groupByRatio(sizes: readonly SizeEntry[]): RatioGroup[] {
  const groups: RatioGroup[] = [];
  for (const s of sizes) {
    const group = groups.find((g) => g.head.w * s.h === s.w * g.head.h);
    if (group) group.members.push(s);
    else groups.push({ head: s, members: [s] });
  }
  return groups;
}

// ln of the ratio quotient, folded to be non-negative so 2:1 and 1:2 are exactly equally far from 1:1.
function ratioDistance(s: SizeEntry, rw: number, rh: number): number {
  const q = (s.w * rh) / (s.h * rw);
  return Math.log(Math.max(q, 1 / q));
}

function nearestGroup(groups: readonly RatioGroup[], rw: number, rh: number): RatioGroup | null {
  let best: RatioGroup | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const g of groups) {
    const d = ratioDistance(g.head, rw, rh);
    if (best === null || d < bestDistance) {
      best = g;
      bestDistance = d;
    }
  }
  return best;
}

function pickByArea(sizes: readonly SizeEntry[], smallest: boolean): SizeEntry | null {
  let best: SizeEntry | null = null;
  for (const s of sizes) {
    const better = best === null || (smallest ? s.w * s.h < best.w * best.h : s.w * s.h > best.w * best.h);
    if (better) best = s;
  }
  return best;
}

function toResolved(s: SizeEntry | null): ResolvedSize | null {
  return s === null ? null : { w: s.w, h: s.h, params: s.params };
}

export function resolveSize(m: ModelEntry, rect: Rect, override?: readonly [number, number]): ResolvedSize | null {
  if (override) return toResolved(m.sizes.find((s) => s.w === override[0] && s.h === override[1]) ?? null);
  const [, , rw, rh] = rect;
  const group = nearestGroup(groupByRatio(m.sizes), rw, rh);
  if (group === null) return null;
  const covering = group.members.filter((s) => s.w >= rw && s.h >= rh);
  return toResolved(covering.length > 0 ? pickByArea(covering, true) : pickByArea(group.members, false));
}
