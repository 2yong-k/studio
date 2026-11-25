import { mkdir, readFile, rm } from 'node:fs/promises';
import { type JsonValue, StudioError } from '../errors.ts';
import { absolutePath, driveHint } from '../home.ts';
import {
  type Issue,
  issueList,
  loadForPriceCheck,
  recordPriceCheck,
  restate,
  type Stated,
  StatedInput,
  samePrice,
  withWorkLock,
} from '../works/index.ts';
import { localDate } from './new.ts';
import { type AppCtx, type Command, parse, single, usageError } from './shared.ts';

const USAGE = 'price-check <model> (--stated <json> | --stated-file <absolute-file>) [--changed]';
const ARG = '--stated';

// `label` names the input the caller gave: `--stated`, or the file's absolute path (on PowerShell the only form that
// works). A file given goes into the details as `file`, as the file's other refusals do.
function badStated(label: string, model: string, issues: Issue[], file?: string): StudioError {
  const why = issues.map((i) => `${i.path}: ${i.message}`).join('; ');
  const where = file === undefined ? {} : { file };
  return usageError(USAGE, `${label} does not fit ${model} (${why})`, { ...where, model, issues });
}

function statedOf(label: string, model: string, text: string, file?: string): StatedInput {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw usageError(USAGE, '--stated is not JSON');
  }
  const parsed = StatedInput.safeParse(value);
  if (parsed.success) return parsed.data;
  throw badStated(label, model, issueList(parsed.error.issues), file);
}

// Absent fields are left out, as in the JSON the price came from.
function priceJson(s: StatedInput, checkedAt?: string): { [k: string]: JsonValue } {
  const { unit, unitPriceUsd, bySize, source } = s;
  return {
    unit,
    ...(unitPriceUsd === undefined ? {} : { unitPriceUsd }),
    ...(bySize === undefined ? {} : { bySize }),
    ...(checkedAt === undefined ? {} : { checkedAt }),
    source,
  };
}

// The page price as --stated text, or the file Claude wrote it to: PowerShell 5.1 mangles JSON in an argument.
type Given = { from: 'arg'; text: string } | { from: 'file'; file: string };
type Check = { id: string; given: Given; confirmed: boolean };

async function readInput(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    const code = e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : null;
    if (code === null) throw e;
    throw usageError(USAGE, `could not read ${file} (${code})`, { file, errno: code });
  }
}

// The file names its model, so a file left from a check of another model is refused instead of recorded as this one.
// Without that field it is the JSON --stated takes.
async function statedInFile(id: string, file: string): Promise<string> {
  const text = await readInput(file);
  let value: JsonValue;
  try {
    value = JSON.parse(text);
  } catch {
    throw usageError(USAGE, `${file} is not JSON`, { file });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value.model === undefined) {
    throw usageError(USAGE, 'the file has no model field', { file });
  }
  const { model, ...rest } = value;
  if (model !== id) {
    const named = typeof model === 'string' ? model : JSON.stringify(model);
    throw usageError(USAGE, `the file's model is ${named}, not ${id}`, { file, model: id, fileModel: model });
  }
  return JSON.stringify(rest);
}

// Removed once recorded, so each check needs a fresh Write and a stale file is never recorded as a later reading. A
// file that is already gone counts as removed.
async function removeInput(file: string): Promise<void> {
  await rm(file, { force: true }).catch((e: unknown) => {
    const error = new StudioError('UNEXPECTED', `recorded, but could not remove ${file}`, { file });
    error.cause = e;
    throw error;
  });
}

// Every refusal comes before the one write, and all of it runs under the studio-folder lock.
async function checkAndRecord(app: AppCtx, { id, given, confirmed }: Check): Promise<{ [k: string]: JsonValue }> {
  const { model: m, record } = await loadForPriceCheck(app.repoRoot, app.home, id);
  if (m === undefined) throw new StudioError('NOT_FOUND', `no model ${id} in the bundled list`, { model: id });
  const page = m.billing.stated;
  if (page === undefined) throw usageError(USAGE, `${id} is priced by the pricing API, with no page price to check`);
  // A record of this model that no longer fits its bundled entry is not in use, so the bundled price stands for it.
  const inUse = record ?? page;
  const today = localDate(app.now());
  // A record counts only from the bundled check's day on, so one dated earlier would be written and never used.
  if (today < page.checkedAt) {
    const why = `the bundled price of ${id} was checked on ${page.checkedAt}, later than today here (${today}); run price-check again on or after ${page.checkedAt}`;
    throw usageError(USAGE, why, { model: id, checkedAt: page.checkedAt, today });
  }
  // The file is read under the lock too, so two checks of one file cannot both record it.
  const [label, text, statedFile] =
    given.from === 'arg' ? [ARG, given.text, undefined] : [given.file, await statedInFile(id, given.file), given.file];
  const input = statedOf(label, id, text, statedFile);
  const stated: Stated = { ...input, checkedAt: today };
  const restated = restate(m, stated);
  if (!restated.ok) throw badStated(label, id, restated.issues, statedFile);
  const changed = !samePrice(input, inUse);
  if (changed && !confirmed) {
    const why = `the page price of ${id} differs from the one in use; confirm it with --changed`;
    throw new StudioError('PRICE_CHANGED', why, {
      model: id,
      before: priceJson(inUse, inUse.checkedAt),
      after: priceJson(input),
    });
  }
  const file = await recordPriceCheck(app.home, id, stated);
  if (given.from === 'file') await removeInput(given.file);
  return { model: id, checkedAt: stated.checkedAt, changed, file };
}

function givenOf(text: string | undefined, file: string | undefined, app: AppCtx): Given {
  if (text !== undefined && file === undefined) return { from: 'arg', text };
  if (file === undefined || text !== undefined) {
    throw usageError(USAGE, 'give the page price with exactly one of --stated and --stated-file');
  }
  // The cwd is wherever the shell running the command is, so a relative path could name another file.
  if (!absolutePath(file, app.platform)) {
    throw usageError(USAGE, `${file} is relative; pass an absolute path${driveHint(app.platform)}`);
  }
  return { from: 'file', file };
}

// Spends nothing and needs no network: it records a page price re-checked today. A price other than the one in use
// is refused until the user has seen it and confirmed it with --changed, so a changed price never reaches an
// estimate unseen. The price in use is read under the lock, so a check running at the same time cannot change it
// between this comparison and the write.
export const priceCheck: Command = async (args, app) => {
  const options = {
    stated: { type: 'string' },
    'stated-file': { type: 'string' },
    changed: { type: 'boolean' },
  } as const;
  const { values, positionals } = parse(args, options, USAGE);
  const id = single(positionals, USAGE);
  const check: Check = {
    id,
    given: givenOf(values.stated, values['stated-file'], app),
    confirmed: values.changed === true,
  };
  // The lock file lives in the studio folder, which a first check may have to create.
  await mkdir(app.home, { recursive: true });
  return withWorkLock(app.home, () => checkAndRecord(app, check));
};
