import { StudioError } from '../errors.ts';
import { ceilDiv, type Micros, mulDiv, toMicros, toUnitPrice } from '../money/index.ts';
import { type ModelEntry, type ResolvedSize, type Stated, sameParams } from '../works/index.ts';

// `refs` counts reference images including the layout guide; `promptBytes` is the prompt's UTF-8 length.
export type BillingRequest = {
  w: number;
  h: number;
  durationMs: number | null;
  fps: number | null;
  refs: number;
  promptBytes: number;
};

const MS_PER_SECOND = 1000n;
const PIXELS_PER_MEGAPIXEL = 1_000_000n;

function needed(value: number | null, what: string, m: ModelEntry): bigint {
  if (value === null) {
    throw new StudioError('UNEXPECTED', `model ${m.id} bills by ${what}, which the request lacks`, {
      model: m.id,
      field: what,
    });
  }
  return BigInt(value);
}

// Token kinds bill the inputs too: each reference image and every prompt byte are bounded as output-priced tokens.
function inputTokens(perRefTokens: number, r: BillingRequest): bigint {
  return BigInt(r.refs) * BigInt(perRefTokens) + BigInt(r.promptBytes);
}

type TokenRow = { w: number; h: number; tokens: number };

function tableTokens(m: ModelEntry, bySize: readonly TokenRow[], r: BillingRequest): bigint {
  const row = bySize.find((s) => s.w === r.w && s.h === r.h);
  if (row === undefined) {
    throw new StudioError('UNEXPECTED', `model ${m.id} has no token row for ${r.w}x${r.h}`, {
      model: m.id,
      w: r.w,
      h: r.h,
    });
  }
  return BigInt(row.tokens);
}

// Rounds up only to the provider's own billing step (whole seconds, megapixels, tokens); unitSize waits for lineAmount.
export function billingQuantity(m: ModelEntry, r: BillingRequest): bigint {
  const q = m.billing.quantity;
  switch (q.kind) {
    case 'per_image':
      return 1n;
    case 'per_second':
      return ceilDiv(needed(r.durationMs, 'duration', m), MS_PER_SECOND);
    case 'per_megapixel':
      return ceilDiv(BigInt(r.w) * BigInt(r.h), PIXELS_PER_MEGAPIXEL);
    case 'video_tokens': {
      const frames = needed(r.fps, 'fps', m) * needed(r.durationMs, 'duration', m);
      return ceilDiv(BigInt(r.w) * BigInt(r.h) * frames, MS_PER_SECOND * BigInt(q.pixelsPerToken));
    }
    case 'fixed_tokens':
      return BigInt(q.tokens) + inputTokens(q.perRefTokens, r);
    case 'image_tokens':
      return tableTokens(m, q.bySize, r) + inputTokens(q.perRefTokens, r);
  }
}

export function lineAmount(unitPriceMicros: Micros, quantity: bigint, unitSize: bigint): Micros {
  return toMicros(mulDiv(unitPriceMicros, quantity, unitSize, 'ceil'));
}

// A quote prices `quantityPerUnit` billed units (e.g. 1M tokens); folding that into unitSize keeps every stored
// line on the one formula amount = ceil(unitPriceMicros × quantity / unitSize). Throws RangeError on a bad price.
export function unitPriceOf(m: ModelEntry, unitPriceUsd: string): { unitPriceMicros: Micros; unitSize: bigint } {
  const { unitPriceMicros, unitSize } = toUnitPrice(unitPriceUsd);
  return { unitPriceMicros, unitSize: unitSize * BigInt(m.billing.quantityPerUnit) };
}

// Rows that send the same params are one request to the provider (e.g. the ratio follows the first frame).
export function sameParamsRows(m: ModelEntry, size: ResolvedSize): { w: number; h: number }[] {
  return m.sizes.filter((s) => sameParams(s.params, size.params)).map((s) => ({ w: s.w, h: s.h }));
}

// Which of the same-params rows the provider will make is unknown, so the estimate takes the largest of them.
export function pricedSize(m: ModelEntry, size: ResolvedSize): { w: number; h: number } {
  let best = { w: size.w, h: size.h };
  for (const s of sameParamsRows(m, size)) if (s.w * s.h > best.w * best.h) best = s;
  return best;
}

// A per-size page price is read at the row the estimate bills; the list check made same-params rows agree on it.
export function statedUsdAt(m: ModelEntry, stated: Stated, size: ResolvedSize): string {
  if (stated.unitPriceUsd !== undefined) return stated.unitPriceUsd;
  const { w, h } = pricedSize(m, size);
  const row = stated.bySize?.find((r) => r.w === w && r.h === h);
  if (row === undefined) {
    throw new StudioError('UNEXPECTED', `model ${m.id} has no stated price row for ${w}x${h}`, { model: m.id, w, h });
  }
  return row.unitPriceUsd;
}
