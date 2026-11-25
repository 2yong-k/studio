import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { z } from 'zod';
import { type AppCtx, COMMANDS, type Command, keyStoreOf } from './commands/index.ts';
import { defaultExec, type Env, type Exec, type Mode, modeOf, studioHome, worksRoot } from './config.ts';
import { type JsonValue, StudioError } from './errors.ts';
import {
  createFakeProvider,
  createLiveProvider,
  FAKE_SCENARIOS,
  type FakeScenario,
  type Provider,
} from './generate/index.ts';
import type { KeyStore } from './key-store.ts';
import { runTool, type ToolRun } from './make/index.ts';

// For tests: the clock, the exec the macOS keychain read and `doctor` use, the tool run `doctor` lists
// Windows voices with, the OS whose rules judge paths passed as arguments and pick the key store, and the home folder
// used when the env names none.
export type Seams = {
  now?: () => Date;
  exec?: Exec;
  toolRun?: ToolRun;
  platform?: NodeJS.Platform;
  homedir?: () => string;
};

// The checkout the code runs from, so data/models.json and the bundled fonts always match the code reading them.
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FAKE_SCRATCH = '.fake-provider';

const Scenario = z.enum(FAKE_SCENARIOS);

function fakeScenario(env: Env): FakeScenario {
  const raw = env.STUDIO_FAKE_SCENARIO;
  const parsed = Scenario.safeParse(raw === undefined || raw === '' ? 'ok' : raw);
  if (parsed.success) return parsed.data;
  throw new StudioError('USAGE', `STUDIO_FAKE_SCENARIO must be one of ${Scenario.options.join(', ')}`, {
    STUDIO_FAKE_SCENARIO: raw ?? null,
  });
}

// The scenario is read only in fake mode, and the key only in live mode, when a command first needs the network.
function providerOf(mode: Mode, root: string, env: Env, store: () => KeyStore): () => Promise<Provider> {
  if (mode === 'live') return async () => createLiveProvider({ key: await store().read() });
  // One scratch dir per works root, so `status` in a later process sees the requests `generate` made.
  return async () => createFakeProvider({ scenario: fakeScenario(env), scratchDir: join(root, FAKE_SCRATCH) });
}

// Settings from the env or the config file name folders on this machine, so the host's rules judge them; only
// arguments and OS behaviour follow app.platform.
async function appCtx(env: Env, seams: Seams, mode: Mode): Promise<AppCtx> {
  const homeFolder = seams.homedir ?? homedir;
  const home = await studioHome(env, process.platform, homeFolder);
  const root = worksRoot(mode, home, env, process.platform);
  const app: AppCtx = {
    mode,
    repoRoot: REPO_ROOT,
    home,
    worksRoot: root,
    provider: providerOf(mode, root, env, () => keyStoreOf(app)),
    now: seams.now ?? (() => new Date()),
    exec: seams.exec ?? defaultExec,
    toolRun: seams.toolRun ?? runTool,
    env,
    platform: seams.platform ?? process.platform,
    homedir: homeFolder,
  };
  return app;
}

function causeText(c: unknown): string {
  if (c instanceof StudioError) return `${c.code}: ${c.message}`;
  return c instanceof Error ? `${c.name}: ${c.message}` : String(c);
}

// A StudioError keeps its own code; anything else is UNEXPECTED as it stands, never dressed up as another code.
// Either way UNEXPECTED leaves its stack, with every cause, on stderr.
function failureOf(e: unknown): { exit: number; error: { [k: string]: JsonValue } } {
  if (!(e instanceof StudioError)) {
    return { exit: 2, error: { code: 'UNEXPECTED', message: e instanceof Error ? e.message : String(e) } };
  }
  const cause = e.cause === undefined ? {} : { cause: causeText(e.cause) };
  return {
    // Exit 1 is a refusal Claude can act on (fix the brief, ask the user). A typed UNEXPECTED only wraps a foreign error
    // to add details; it is still a bug to report with its stack, so it exits 2 like an untyped one.
    exit: e.code === 'UNEXPECTED' ? 2 : 1,
    error: { code: e.code, message: e.message, details: e.details ?? null, ...cause },
  };
}

// A Windows console may decode stdout in a legacy code page and mangle a non-ASCII folder name, so there every UTF-16
// unit past ASCII goes out as a JSON escape, which parses back to the same text.
export function stdoutText(body: { [k: string]: JsonValue }, platform: NodeJS.Platform): string {
  const text = `${JSON.stringify(body, null, 2)}\n`;
  if (platform !== 'win32') return text;
  return text.replace(/[\u007f-\uffff]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function commandOf(name: string | undefined): Command {
  const command = name !== undefined && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (command !== undefined) return command;
  const known = Object.keys(COMMANDS).join(', ');
  throw new StudioError('USAGE', `unknown command ${name ?? '(none)'}; one of ${known}`, { command: name ?? null });
}

export async function main(argv: readonly string[], env: Env, seams: Seams = {}): Promise<number> {
  const platform = seams.platform ?? process.platform;
  const write = (body: { [k: string]: JsonValue }): void => {
    process.stdout.write(stdoutText(body, platform));
  };
  try {
    const { mode, argv: rest } = modeOf(argv, env);
    const app = await appCtx(env, seams, mode);
    const [name, ...args] = rest;
    write({ ok: true, mode: app.mode, ...(await commandOf(name)(args, app)) });
    return 0;
  } catch (e) {
    const { exit, error } = failureOf(e);
    if (exit === 2) process.stderr.write(`${inspect(e)}\n`);
    write({ ok: false, error });
    return exit;
  }
}
