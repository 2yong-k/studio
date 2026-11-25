import { join } from 'node:path';
import { z } from 'zod';
import type { Mode } from '../config.ts';
import { sha256File } from './files.ts';

// One spelling per value: a sign, leading zero, fraction or exponent would let two strings name one amount.
export const IntString = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const HashString = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const Instant = z.iso.datetime();
export const ModeSchema = z.enum(['fake', 'live']) satisfies z.ZodType<Mode>;

const Id = z.string().min(1);

const EstimateLineSchema = z.strictObject({
  element: Id,
  model: Id,
  unit: Id,
  unitSize: IntString,
  unitPriceMicros: IntString,
  quantity: IntString,
  amountMicros: IntString,
  priceSource: z.string().min(1),
  dependsOn: Id.nullable(),
});

export const EstimateSchema = z.strictObject({
  schema: z.literal(1),
  mode: ModeSchema,
  briefHash: HashString,
  createdAt: Instant,
  lines: z.array(EstimateLineSchema),
  spendMicros: IntString,
  subtotalMicros: IntString,
  marginRate: z.literal('0.2'),
  capMicros: IntString,
});

export type EstimateLine = z.infer<typeof EstimateLineSchema>;
export type Estimate = z.infer<typeof EstimateSchema>;

export const ESTIMATE_FILE = 'estimate.json';

// Raw bytes, like briefHash: an approval names this exact file, so any edit to it reads as a new estimate.
export function estimateHash(workDir: string): Promise<string> {
  return sha256File(join(workDir, ESTIMATE_FILE));
}
