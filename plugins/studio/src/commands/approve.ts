import { join } from 'node:path';
import { StudioError } from '../errors.ts';
import { budgetOf } from '../generate/index.ts';
import {
  acceptedOf,
  appendApproval,
  attempts,
  type Brief,
  briefHash,
  ESTIMATE_FILE,
  type EstimateApproval,
  EstimateSchema,
  elementInputHash,
  type KeyframeConfirm,
  loadBriefHashed,
  readJsonHashed,
} from '../works/index.ts';
import { type AppCtx, briefCtxOf, type Command, parse, single, workDirOf } from './shared.ts';

const USAGE = 'approve <work> [--keyframes]';

async function readEstimate(workDir: string, work: string) {
  try {
    return await readJsonHashed(join(workDir, ESTIMATE_FILE), EstimateSchema);
  } catch (e) {
    if (e instanceof StudioError && e.code === 'NOT_FOUND') {
      throw new StudioError('USAGE', `${work} has no estimate to approve; run estimate first`, { work });
    }
    throw e;
  }
}

// The approval binds one brief to one estimate, so an estimate made for other brief bytes or another mode is refused
// rather than approved against a brief it never priced.
async function approveEstimate(app: AppCtx, work: string, workDir: string) {
  const { value: estimate, sha256 } = await readEstimate(workDir, work);
  const field =
    estimate.mode !== app.mode ? 'mode' : estimate.briefHash !== (await briefHash(workDir)) ? 'briefHash' : null;
  if (field !== null) {
    throw new StudioError('APPROVAL_STALE', `the estimate no longer matches the work's ${field}; estimate again`, {
      field,
    });
  }
  const approval: EstimateApproval = {
    schema: 1,
    kind: 'estimate',
    at: app.now().toISOString(),
    mode: app.mode,
    briefHash: estimate.briefHash,
    estimateHash: sha256,
    subtotalMicros: estimate.subtotalMicros,
    capMicros: estimate.capMicros,
  };
  await appendApproval(workDir, approval);
  return { work, approval, ...(await budgetOf(workDir)) };
}

// A given file is not confirmed here: the user chose it in the conversation before it went into the brief.
const keyframeIds = (brief: Brief): string[] =>
  brief.elements.flatMap((e) =>
    e.method === 'generate' && e.output === 'video' && e.from !== undefined ? [e.from] : [],
  );

// Only attempts accepted for the keyframe's current inputs: an older one is not what the video would open on.
async function confirmKeyframes(app: AppCtx, work: string, workDir: string) {
  const ctx = await briefCtxOf(app, workDir);
  const { brief } = await loadBriefHashed(ctx);
  const views = await attempts(workDir);
  const confirmed: KeyframeConfirm['attempts'] = [];
  for (const id of keyframeIds(brief)) {
    const view = acceptedOf(views, id, await elementInputHash(ctx, brief, id));
    const sha256 = view?.last.sha256 ?? null;
    if (view !== null && sha256 !== null) confirmed.push({ attempt: view.attempt, sha256 });
  }
  if (confirmed.length === 0) {
    throw new StudioError('USAGE', `${work} has no accepted keyframe for its current inputs to confirm`, { work });
  }
  const confirmation: KeyframeConfirm = {
    schema: 1,
    kind: 'keyframes',
    at: app.now().toISOString(),
    attempts: confirmed,
  };
  await appendApproval(workDir, confirmation);
  return { work, confirmation };
}

// Run only after the user approved the estimate, or confirmed the keyframes, in the conversation (hard rule 1).
export const approve: Command = async (args, app) => {
  const { values, positionals } = parse(args, { keyframes: { type: 'boolean' } }, USAGE);
  const work = single(positionals, USAGE);
  const workDir = await workDirOf(app, work);
  return values.keyframes === true ? confirmKeyframes(app, work, workDir) : approveEstimate(app, work, workDir);
};
