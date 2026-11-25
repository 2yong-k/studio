import { budgetOf, generateElement, generatePending } from '../generate/index.ts';
import { type Command, genCtxOf, loadWork, parse, single, usageError } from './shared.ts';

const USAGE = 'generate <work> [--element <id> [--reason <defect>]]';

// Spends money. Every result carries its own error and cause: an unresolved attempt is settled from those, by status
// or resolve, never by sending again.
export const generate: Command = async (args, app) => {
  const options = { element: { type: 'string' }, reason: { type: 'string' } } as const;
  const { values, positionals } = parse(args, options, USAGE);
  const work = single(positionals, USAGE);
  const { element, reason } = values;
  if (reason !== undefined && element === undefined) throw usageError(USAGE, '--reason needs --element');
  if (reason === '') throw usageError(USAGE, '--reason must name the defect');
  const provider = await app.provider();
  const w = await loadWork(app, work);
  const g = genCtxOf(app, w, provider);
  const made =
    element === undefined ? await generatePending(g) : { results: [await generateElement(g, element, reason ?? null)] };
  return { work, ...made, ...(await budgetOf(w.ctx.workDir)) };
};
