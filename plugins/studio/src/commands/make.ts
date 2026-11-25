import { makeCandidate, pickRaws } from '../make/index.ts';
import { type Command, loadWork, parse, single, usageError } from './shared.ts';

const USAGE = 'make <work> [--use <element>=<attempt>]...';
const USE = /^([^=]+)=([1-9][0-9]*)$/;

// fromEntries makes own keys, so an element id such as "__proto__" stays an ordinary key.
function useOf(pairs: readonly string[]): Record<string, number> {
  const entries: [string, number][] = [];
  for (const p of pairs) {
    const [, id, n] = USE.exec(p) ?? [];
    const attempt = n === undefined ? Number.NaN : Number.parseInt(n, 10);
    if (id === undefined || !Number.isSafeInteger(attempt)) throw usageError(USAGE, `--use ${p} is not <element>=<n>`);
    if (entries.some(([seen]) => seen === id)) throw usageError(USAGE, `--use names ${id} twice`);
    entries.push([id, attempt]);
  }
  return Object.fromEntries(entries);
}

// Free to repeat: it reads no approval and sends nothing.
export const make: Command = async (args, app) => {
  const { values, positionals } = parse(args, { use: { type: 'string', multiple: true } }, USAGE);
  const work = single(positionals, USAGE);
  const use = useOf(values.use ?? []);
  const w = await loadWork(app, work);
  const raws = await pickRaws(w.ctx, w.brief, use);
  const { file, warnings } = await makeCandidate(w.ctx, w.brief, raws);
  return { work, file, raws: Object.fromEntries(raws), warnings };
};
