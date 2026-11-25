import { formatUsd, parseMicros } from '../money/index.ts';
import { latestEstimateApproval, workSpend } from '../works/index.ts';

type Budget = {
  spend: string;
  approved: string | null;
  cap: string | null;
  usd: { spend: string; approved: string | null; cap: string | null };
  budget?: 'margin_in_use';
};

// Work spend against the approval in force. Once spend reaches the approved subtotal, every retry draws on the
// margin, and Claude tells the user so.
export async function budgetOf(workDir: string): Promise<Budget> {
  const spend = await workSpend(workDir);
  const approval = await latestEstimateApproval(workDir);
  if (approval === null) {
    return {
      spend: spend.toString(),
      approved: null,
      cap: null,
      usd: { spend: formatUsd(spend), approved: null, cap: null },
    };
  }
  const approved = parseMicros(approval.subtotalMicros);
  const budget: Budget = {
    spend: spend.toString(),
    approved: approval.subtotalMicros,
    cap: approval.capMicros,
    usd: { spend: formatUsd(spend), approved: formatUsd(approved), cap: formatUsd(parseMicros(approval.capMicros)) },
  };
  return spend >= approved ? { ...budget, budget: 'margin_in_use' } : budget;
}
