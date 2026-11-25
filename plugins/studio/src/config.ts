import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { StudioError } from './errors.ts';
import { absolutePath, CONFIG_FOLDER, driveHint, pathFor, userHome } from './home.ts';
import { readJson } from './works/index.ts';

export type Mode = 'fake' | 'live';
export type Env = Readonly<Record<string, string | undefined>>;
export type Exec = (cmd: string, args: readonly string[]) => Promise<{ stdout: string; code: number }>;
export type ExecIn = (cmd: string, args: readonly string[], stdin: string) => Promise<{ code: number }>;

// Outside Claude Code's own folders, so the CLI finds the studio folder without the plugin's environment.
const CONFIG_FILE = [...CONFIG_FOLDER, 'config.json'] as const;
// Claude Code hands each plugin option, the key included, to a hook in a variable named this way.
const PLUGIN_OPTION_PREFIX = 'CLAUDE_PLUGIN_OPTION_';

export const StudioConfig = z.strictObject({
  schema: z.literal(1),
  home: z.string().refine((p) => absolutePath(p), `must be an absolute path${driveHint(process.platform)}`),
});
export type StudioConfig = z.infer<typeof StudioConfig>;

// Windows runs a same-named program from the working folder first; the plugin folder holds none.
const EXEC_CWD = fileURLToPath(new URL('..', import.meta.url));

// A non-zero exit resolves so each caller decides what it means; only a spawn failure or a signal rejects.
export const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: EXEC_CWD }, (error, stdout) => {
      if (error === null) resolve({ stdout, code: 0 });
      else if (typeof error.code === 'number') resolve({ stdout, code: error.code });
      else reject(error);
    });
  });

// The env a child program gets: the plugin options, the key among them, never reach a program that does not need it.
export function withoutPluginOptions(env: Env): Record<string, string> {
  const childEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !name.startsWith(PLUGIN_OPTION_PREFIX)) childEnv[name] = value;
  }
  return childEnv;
}

// Windows' own folder, where PowerShell is started from by its full path: a relative one would be looked up from the
// folder the CLI runs in, the user's project. An empty SystemRoot counts as unset, so SYSTEMROOT still serves.
export function systemRoot(env: Env): { ok: true; root: string } | { ok: false; reason: string } {
  const root = [env.SystemRoot, env.SYSTEMROOT].find((v) => v !== undefined && v !== '');
  if (root === undefined) return { ok: false, reason: 'SystemRoot is not set' };
  if (!absolutePath(root, 'win32')) return { ok: false, reason: 'SystemRoot is not an absolute path' };
  return { ok: true, root };
}

// The child's output is dropped unread: `security -i` may echo the line it was given, key and all, and a
// SessionStart hook's stdout goes into the conversation. The child gets env without the plugin options, so the key
// reaches it only on stdin.
export function execIn(env: Env): ExecIn {
  const childEnv = withoutPluginOptions(env);
  return (cmd, args, stdin) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], env: childEnv });
      child.once('error', reject);
      // A child that exits before reading all its stdin breaks the pipe, which POSIX reports as EPIPE and Windows as
      // EOF. Whether the write lands first is a race, so it says nothing the exit code does not; the exit code alone
      // tells the outcome.
      child.stdin.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code !== 'EPIPE' && e.code !== 'EOF') reject(e);
      });
      child.once('close', (code, signal) => {
        if (code === null) reject(new Error(`${cmd} ended by ${signal ?? 'a signal'}`));
        else resolve({ code });
      });
      child.stdin.end(stdin);
    });
}

// The mode comes only from a leading --live. A STUDIO_MODE left in a shell profile stops every run, even one with
// --live, so a stale value can never pick the mode unseen.
export function modeOf(argv: readonly string[], env: Env): { mode: Mode; argv: readonly string[] } {
  const stale = env.STUDIO_MODE;
  if (stale !== undefined && stale !== '') {
    throw new StudioError(
      'MODE_INVALID',
      'STUDIO_MODE is no longer read; for live mode put --live before the command (studio --live <command>) and unset STUDIO_MODE',
      { STUDIO_MODE: stale },
    );
  }
  if (argv[0] === '--live') return { mode: 'live', argv: argv.slice(1) };
  return { mode: 'fake', argv };
}

export function configPath(env: Env, platform: NodeJS.Platform, fallback: () => string): string | null {
  const home = userHome(env, platform, fallback);
  return home === null ? null : pathFor(platform).join(home, ...CONFIG_FILE);
}

async function configuredHome(file: string): Promise<string | null> {
  try {
    return (await readJson(file, StudioConfig)).home;
  } catch (e) {
    if (e instanceof StudioError && e.code === 'NOT_FOUND') return null;
    throw badConfig(file, e);
  }
}

// Past a missing file the config file is at fault: readJson reports a bad JSON or schema as BRIEF_INVALID with
// { file, issues }, and a path it cannot read (a folder, no permission) as the fs error, kept as the cause.
function badConfig(file: string, e: unknown): StudioError {
  const why = `${file} is not a valid studio config; set the studio folder with /plugin configure`;
  if (e instanceof StudioError && e.code === 'BRIEF_INVALID') return new StudioError('CONFIG_INVALID', why, e.details);
  const error = new StudioError('CONFIG_INVALID', why, { file });
  error.cause = e;
  return error;
}

// An explicit STUDIO_HOME wins, then the file the plugin writes. With neither the CLI stops rather than guess a
// folder, so works never land in whatever repo it happens to run inside.
export async function studioHome(env: Env, platform: NodeJS.Platform, fallback: () => string): Promise<string> {
  const fromEnv = env.STUDIO_HOME;
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!absolutePath(fromEnv, platform)) {
      const why = `STUDIO_HOME must be an absolute path${driveHint(platform)}`;
      throw new StudioError('CONFIG_INVALID', why, { STUDIO_HOME: fromEnv });
    }
    return fromEnv;
  }
  const file = configPath(env, platform, fallback);
  const home = file === null ? null : await configuredHome(file);
  if (home === null) {
    throw new StudioError('CONFIG_INVALID', 'no studio folder is set; set the studio folder with /plugin configure', {
      file,
    });
  }
  return home;
}

export function worksRoot(mode: Mode, home: string, env: Env, platform: NodeJS.Platform): string {
  if (mode === 'live') return pathFor(platform).join(home, 'works');
  const override = env.STUDIO_WORKS_ROOT;
  if (override === undefined || override === '') return pathFor(platform).join(home, 'works-fake');
  if (!absolutePath(override, platform)) {
    const why = `STUDIO_WORKS_ROOT must be an absolute path${driveHint(platform)}`;
    throw new StudioError('USAGE', why, { STUDIO_WORKS_ROOT: override });
  }
  return override;
}
