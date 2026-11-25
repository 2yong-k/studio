import type { Brief, Cut } from '../works/index.ts';

type VideoBrief = Extract<Brief, { kind: 'video' }>;

export type CutPlan = { cut: Cut; startMs: number; first: number; last: number };

// The preview and the final film must cut at the same frames, so both read their boundaries from here.
// Frame numbers come from running totals so rounding does not pile up over many cuts.
export function planCuts(brief: VideoBrief): CutPlan[] {
  const { fps } = brief.frame;
  const plans: CutPlan[] = [];
  let startMs = 0;
  for (const cut of brief.cuts) {
    const first = Math.round((startMs * fps) / 1000);
    const last = Math.max(first + 1, Math.round(((startMs + cut.durationMs) * fps) / 1000));
    plans.push({ cut, startMs, first, last });
    startMs += cut.durationMs;
  }
  return plans;
}

// Time inside the cut of global frame n; the rounded boundary can fall a hair outside the cut, so it is clamped.
export function cutTimeMs(plan: CutPlan, n: number, fps: number): number {
  return Math.min(plan.cut.durationMs, Math.max(0, (n * 1000) / fps - plan.startMs));
}
