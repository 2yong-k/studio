import { join } from 'node:path';
import type { JsonValue } from '../errors.ts';
import { buildEstimate, estimateUsd, type Provider, removalSavings } from '../generate/index.ts';
import { ESTIMATE_FILE, EstimateSchema, withWorkLock, writeJsonAtomic } from '../works/index.ts';
import { type AppCtx, type Command, type LoadedWork, loadWork, parse, single } from './shared.ts';

const USAGE = 'estimate <work>';

// Under the work lock, so the spend it reads is not moving under a generate in flight.
export async function estimateWork(
  app: AppCtx,
  w: LoadedWork,
  provider: Provider,
): Promise<{ [k: string]: JsonValue }> {
  const estimate = await withWorkLock(w.ctx.workDir, async () => {
    const { ctx, brief, briefHash } = w;
    const built = await buildEstimate({ ctx, brief, briefHash, provider, mode: app.mode, now: app.now() });
    await writeJsonAtomic(join(ctx.workDir, ESTIMATE_FILE), EstimateSchema, built);
    return built;
  });
  return { work: w.work, estimate, removalSavings: removalSavings(estimate), usd: estimateUsd(estimate) };
}

export const estimate: Command = async (args, app) => {
  const { positionals } = parse(args, {}, USAGE);
  const work = single(positionals, USAGE);
  // Live mode reads the key here, before anything else, and stops on KEY_MISSING.
  const provider = await app.provider();
  return estimateWork(app, await loadWork(app, work), provider);
};
