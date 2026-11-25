import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { type ParseArgsConfig, parseArgs } from 'node:util';
import { configPath, type Exec, type ExecIn, type Mode } from '../config.ts';
import { type JsonValue, StudioError } from '../errors.ts';
import type { GenCtx, Provider, SettleCtx } from '../generate/index.ts';
import { NO_HOME_FOLDER } from '../home.ts';
import { type KeyStore, keyStore } from '../key-store.ts';
import { type ToolRun, textChecks } from '../make/index.ts';
import { type Brief, type BriefCtx, loadBriefHashed, loadModels } from '../works/index.ts';

// repoRoot is the code folder (data/models.json, bundled fonts, node_modules) and home the studio folder (works,
// assets, records), so updating the code never touches what the user made.
export type AppCtx = {
  mode: Mode;
  repoRoot: string;
  home: string;
  worksRoot: string;
  provider: () => Promise<Provider>;
  now: () => Date;
  // The external programs a command may ask (ffmpeg, security, say); tests hand in a fake.
  exec: Exec;
  // A program run with a time limit and an env of its own (PowerShell listing the voices); tests hand in a fake.
  toolRun: ToolRun;
  env: Readonly<Record<string, string | undefined>>;
  // The OS whose rules apply to paths the user passes and to OS behaviour, and the home folder used when the env names
  // none; tests inject both.
  readonly platform: NodeJS.Platform;
  readonly homedir: () => string;
};
export type Command = (args: readonly string[], app: AppCtx) => Promise<{ [k: string]: JsonValue }>;

export type LoadedWork = { work: string; ctx: BriefCtx; brief: Brief; briefHash: string };

// What `new` makes: the local date and a lower-case name, so a work name never leaves the works root.
const WORK_NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/;
// Polling a real queue faster only spends rate limit; the fake answers at once.
const POLL_MS: Readonly<Record<Mode, number>> = { live: 5000, fake: 10 };

type Options = NonNullable<ParseArgsConfig['options']>;

export const usageError = (usage: string, why: string, details: { [k: string]: JsonValue } = {}): StudioError =>
  new StudioError('USAGE', `${why}; usage: studio ${usage}`, { usage, ...details });

export const errno = (e: unknown, code: string): boolean => e instanceof Error && 'code' in e && e.code === code;

function isParseError(e: unknown): e is TypeError {
  return e instanceof TypeError && 'code' in e && typeof e.code === 'string' && e.code.startsWith('ERR_PARSE_ARGS_');
}

// Strict, so an unknown flag or a flag missing its value is USAGE instead of being ignored.
export function parse<const O extends Options>(args: readonly string[], options: O, usage: string) {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (e) {
    if (isParseError(e)) throw usageError(usage, e.message);
    throw e;
  }
}

export function single(positionals: readonly string[], usage: string): string {
  const [only, ...rest] = positionals;
  if (only === undefined || rest.length > 0) throw usageError(usage, `expected 1 argument, got ${positionals.length}`);
  return only;
}

export function pair(positionals: readonly string[], usage: string): [string, string] {
  const [first, second, ...rest] = positionals;
  if (first === undefined || second === undefined || rest.length > 0) {
    throw usageError(usage, `expected 2 arguments, got ${positionals.length}`);
  }
  return [first, second];
}

// Only the session-start hook stores the key. A store that always refuses means no command, and no test that injects
// darwin, can ever reach `security -i` and overwrite a real key.
const NO_STORE: ExecIn = () => Promise.reject(new Error('the CLI never stores a key'));

// The config folder comes from the env, so the host's rules judge it. Asked for only when the key is used, so a fake
// mode command never looks for a home folder; a fallback that throws is a bug and propagates.
function configDirOf(app: AppCtx): string {
  const file = configPath(app.env, process.platform, app.homedir);
  if (file === null) throw new StudioError('UNEXPECTED', NO_HOME_FOLDER);
  return dirname(file);
}

export function keyStoreOf(app: AppCtx): KeyStore {
  return keyStore(app.platform, () => configDirOf(app), app.exec, NO_STORE);
}

export async function workDirOf(app: AppCtx, work: string): Promise<string> {
  if (!WORK_NAME.test(work)) {
    throw new StudioError('USAGE', `not a work folder name: ${work} (expected <YYYY-MM-DD>-<name>)`, { work });
  }
  const dir = join(app.worksRoot, work);
  const found = await stat(dir).catch((e: unknown) => {
    if (errno(e, 'ENOENT')) return null;
    throw e;
  });
  if (found === null || !found.isDirectory()) {
    throw new StudioError('NOT_FOUND', `no work ${work} in ${app.worksRoot}`, { work, worksRoot: app.worksRoot });
  }
  return dir;
}

export async function briefCtxOf(app: AppCtx, workDir: string): Promise<BriefCtx> {
  return { workDir, repoRoot: app.repoRoot, home: app.home, models: await loadModels(app.repoRoot, app.home) };
}

// Hash and brief come from one read; the glyph check stops a character the font cannot draw before any price or file.
// Its layout warnings are dropped here: preview and make report them beside the frames they draw.
export async function loadWork(app: AppCtx, work: string): Promise<LoadedWork> {
  const ctx = await briefCtxOf(app, await workDirOf(app, work));
  const { brief, briefHash } = await loadBriefHashed(ctx);
  await textChecks({ codeRoot: app.repoRoot, home: app.home }, brief);
  return { work, ctx, brief, briefHash };
}

export function settleCtxOf(app: AppCtx, ctx: BriefCtx, provider: Provider): SettleCtx {
  return {
    ctx,
    provider,
    now: app.now,
    sleep: async (ms) => {
      await delay(ms);
    },
    pollMs: POLL_MS[app.mode],
  };
}

export function genCtxOf(app: AppCtx, w: LoadedWork, provider: Provider): GenCtx {
  return { ...settleCtxOf(app, w.ctx, provider), mode: app.mode, brief: w.brief, briefHash: w.briefHash };
}
