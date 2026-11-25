import { join } from 'node:path';
import { z } from 'zod';
import { HashString, Instant, IntString, ModeSchema } from './estimate.ts';
import { appendJsonl, readJsonl } from './files.ts';

const APPROVALS_FILE = 'approvals.jsonl';

const EstimateApprovalSchema = z.strictObject({
  schema: z.literal(1),
  kind: z.literal('estimate'),
  at: Instant,
  mode: ModeSchema,
  briefHash: HashString,
  estimateHash: HashString,
  subtotalMicros: IntString,
  capMicros: IntString,
});

const KeyframeConfirmSchema = z.strictObject({
  schema: z.literal(1),
  kind: z.literal('keyframes'),
  at: Instant,
  attempts: z.array(z.strictObject({ attempt: z.string().min(1), sha256: HashString })).min(1),
});

const ApprovalLineSchema = z.discriminatedUnion('kind', [EstimateApprovalSchema, KeyframeConfirmSchema]);

export type EstimateApproval = z.infer<typeof EstimateApprovalSchema>;
export type KeyframeConfirm = z.infer<typeof KeyframeConfirmSchema>;

const approvalsFile = (workDir: string): string => join(workDir, APPROVALS_FILE);

export async function appendApproval(workDir: string, line: EstimateApproval | KeyframeConfirm): Promise<void> {
  await appendJsonl(approvalsFile(workDir), ApprovalLineSchema, line);
}

// Keyframe confirmations sit between estimate approvals without replacing the one in force.
export async function latestEstimateApproval(workDir: string): Promise<EstimateApproval | null> {
  const lines = await readJsonl(approvalsFile(workDir), ApprovalLineSchema);
  return lines.findLast((l): l is EstimateApproval => l.kind === 'estimate') ?? null;
}

// A sha names file content, so a re-made keyframe has a new sha and needs a confirmation of its own.
export async function confirmedKeyframeShas(workDir: string): Promise<ReadonlySet<string>> {
  const lines = await readJsonl(approvalsFile(workDir), ApprovalLineSchema);
  return new Set(lines.flatMap((l) => (l.kind === 'keyframes' ? l.attempts.map((a) => a.sha256) : [])));
}
