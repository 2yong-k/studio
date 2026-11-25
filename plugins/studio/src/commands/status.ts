import { budgetOf, settleAllSent } from '../generate/index.ts';
import { attempts } from '../works/index.ts';
import { briefCtxOf, type Command, parse, settleCtxOf, single, workDirOf } from './shared.ts';

const USAGE = 'status <work>';

// Reads no brief: a sent attempt settles from its own spend lines, so a brief edited since cannot block it.
export const status: Command = async (args, app) => {
  const { positionals } = parse(args, {}, USAGE);
  const work = single(positionals, USAGE);
  const provider = await app.provider();
  const workDir = await workDirOf(app, work);
  const results = await settleAllSent(settleCtxOf(app, await briefCtxOf(app, workDir), provider));
  // No request id, so nothing here can ask the provider; the user checks the console and resolve records the answer.
  const submitting = (await attempts(workDir))
    .filter((v) => v.last.state === 'submitting')
    .map((v) => ({ attempt: v.attempt, element: v.element, at: v.last.at }));
  return { work, results, submitting, ...(await budgetOf(workDir)) };
};
