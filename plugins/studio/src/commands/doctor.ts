import { access, constants, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StudioError } from '../errors.ts';
import { keyUnsafeText } from '../key-store.ts';
import { describeVoices } from '../make/index.ts';
import { nodeProblem, nodeSupported } from '../plugin/preflight.mjs';
import { type AppCtx, type Command, errno, keyStoreOf, parse, usageError } from './shared.ts';

const USAGE = 'doctor';
const NOT_STORED = 'not stored; add it with /plugin configure, then start a new session';
// The floor is the major of Ubuntu 24.04's apt ffmpeg (6.1), on which the make and generate paths, video assembly
// included, are checked to run.
const MIN_FFMPEG_MAJOR = 6;
// The floor release's date on ffmpeg.org, so it moves with MIN_FFMPEG_MAJOR: a dated git build from after it holds
// every change that release brought.
const MIN_FFMPEG_RELEASED = '2023-02-28';

type CheckId = 'node' | 'ffmpeg' | 'home' | 'key' | 'voices';
type Check = { id: CheckId; ok: boolean; detail: string };

const check = (id: CheckId, ok: boolean, detail: string): Check => ({ id, ok, detail });
const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function checkNode(version: string): Check {
  const ok = nodeSupported(version);
  return check('node', ok, ok ? version : (nodeProblem(version) ?? version));
}

export type FfmpegBuild = { kind: 'release'; major: number } | { kind: 'dated'; date: string } | { kind: 'undated' };

// A release covers `8.0`, `8.0.1-tessus`, `n8.0` and gyan.dev's `8.0-essentials_build`; two digits at most, so a
// gyan.dev date build (`2025-09-15-git-...`) never reads as release 2025. An `N-12345-g...` build names no date.
const RELEASE = /^ffmpeg version n?(\d{1,2})(?:[.\s-]|$)/i;
const DATED = /^ffmpeg version (\d{4}-\d{2}-\d{2})-git/i;
const UNDATED = /^ffmpeg version N-\d+-g[0-9a-f]+/i;

export function ffmpegBuild(versionLine: string): FfmpegBuild | null {
  const release = RELEASE.exec(versionLine)?.[1];
  if (release !== undefined) return { kind: 'release', major: Number.parseInt(release, 10) };
  const date = DATED.exec(versionLine)?.[1];
  if (date !== undefined) return { kind: 'dated', date };
  return UNDATED.test(versionLine) ? { kind: 'undated' } : null;
}

// stdout when the program ran and exited 0, else the detail the check reports; notFound replaces a spawn ENOENT, and
// `run` names the run in an exit code's detail when one program runs twice.
type Ran = { ok: true; stdout: string } | { ok: false; detail: string };

async function tryRun(
  app: AppCtx,
  cmd: string,
  args: readonly string[],
  notFound: string | null,
  run = cmd,
): Promise<Ran> {
  try {
    const { stdout, code } = await app.exec(cmd, args);
    return code === 0 ? { ok: true, stdout } : { ok: false, detail: `${run} exited with code ${code}` };
  } catch (e) {
    return { ok: false, detail: notFound !== null && errno(e, 'ENOENT') ? notFound : reasonOf(e) };
  }
}

function versionCheck(first: string): Check {
  const build = ffmpegBuild(first);
  if (build === null) return check('ffmpeg', false, first === '' ? 'no version line' : first);
  switch (build.kind) {
    case 'release':
      return check('ffmpeg', build.major >= MIN_FFMPEG_MAJOR, first);
    case 'dated':
      return check('ffmpeg', build.date > MIN_FFMPEG_RELEASED, first);
    case 'undated':
      return check('ffmpeg', true, `${first} (git build of unknown age)`);
  }
}

// Previews and finished videos are encoded with these two. Only the name column after the flags counts: a sibling's
// description names them too (`aac_at` ... `aac (AudioToolbox)`, `libx264rgb` ... `libx264 H.264`).
const ENCODERS = [
  ['libx264', /^\s*[A-Z.]{6}\s+libx264\s/],
  ['aac', /^\s*[A-Z.]{6}\s+aac\s/],
] as const;

// Node starts a bare name on Windows only as a .com or .exe file, so a .cmd or .bat shim reads as not found.
const winNotFound = (name: string): string => `${name}.exe was not found on PATH (.cmd/.bat shims cannot be started)`;
// Ubuntu 24.04's apt ffmpeg (6.1) meets the floor, so on Linux every failure can name that package as the way out.
const LINUX_HINT = `; install ffmpeg ${MIN_FFMPEG_MAJOR} or newer with ffprobe (Ubuntu 24.04 and later: sudo apt install ffmpeg)`;

async function checkFfmpeg(app: AppCtx): Promise<Check> {
  const result = await probeFfmpeg(app);
  return app.platform === 'linux' && !result.ok ? { ...result, detail: `${result.detail}${LINUX_HINT}` } : result;
}

async function probeFfmpeg(app: AppCtx): Promise<Check> {
  const version = await tryRun(app, 'ffmpeg', ['-version'], app.platform === 'win32' ? winNotFound('ffmpeg') : null);
  if (!version.ok) return check('ffmpeg', false, version.detail);
  const byVersion = versionCheck(version.stdout.split('\n')[0]?.trim() ?? '');
  if (!byVersion.ok) return byVersion;
  const ffprobe = await tryRun(
    app,
    'ffprobe',
    ['-version'],
    app.platform === 'win32' ? winNotFound('ffprobe') : 'ffprobe was not found',
  );
  if (!ffprobe.ok) return check('ffmpeg', false, ffprobe.detail);
  const encoders = await tryRun(app, 'ffmpeg', ['-hide_banner', '-encoders'], null, 'ffmpeg -encoders');
  if (!encoders.ok) return check('ffmpeg', false, encoders.detail);
  const lines = encoders.stdout.split('\n');
  const missing = ENCODERS.find(([, listed]) => !lines.some((l) => listed.test(l)));
  return missing === undefined ? byVersion : check('ffmpeg', false, `ffmpeg has no ${missing[0]} encoder`);
}

// Looks only: the nearest folder that exists must take a new folder, but none is made.
async function checkHome(home: string): Promise<Check> {
  let dir = home;
  for (;;) {
    const found = await stat(dir).catch((e: unknown) => {
      if (errno(e, 'ENOENT')) return null;
      return e instanceof Error ? e : new Error(String(e));
    });
    if (found instanceof Error) return check('home', false, found.message);
    if (found !== null) {
      if (!found.isDirectory()) return check('home', false, `${dir} is not a folder`);
      const writable = await access(dir, constants.W_OK).then(
        () => true,
        () => false,
      );
      if (!writable) return check('home', false, `${dir} is not writable`);
      return check('home', true, dir === home ? 'exists' : `will be created under ${dir}`);
    }
    const parent = dirname(dir);
    if (parent === dir) return check('home', false, `no folder above ${home} exists`);
    dir = parent;
  }
}

// Asks only whether the key is there: the keychain without -w, the file through lstat, which never opens it.
async function checkKey(app: AppCtx): Promise<Check> {
  try {
    const store = keyStoreOf(app);
    const state = await store.state();
    const keychain = store.kind === 'keychain';
    switch (state) {
      case 'present':
        return check('key', true, keychain ? 'found in the keychain' : `stored in ${store.where()}`);
      case 'absent':
        return check('key', false, keychain ? 'not in the keychain' : NOT_STORED);
      case 'unsafe':
        return check('key', false, keyUnsafeText(store.where()));
    }
  } catch (e) {
    if (e instanceof StudioError) return check('key', false, e.message);
    throw e;
  }
}

async function checkVoices(app: AppCtx): Promise<Check> {
  const { ok, detail } = await describeVoices(app.platform, app.exec, app.env, app.toolRun);
  return check('voices', ok, detail);
}

// A failing check is a result, so the command still ends ok and lists every check.
export const doctor: Command = async (args, app) => {
  const { positionals } = parse(args, {}, USAGE);
  if (positionals.length > 0) throw usageError(USAGE, 'doctor takes no arguments');
  const checks = [
    checkNode(process.versions.node),
    await checkFfmpeg(app),
    await checkHome(app.home),
    await checkKey(app),
    await checkVoices(app),
  ];
  return { home: app.home, checks };
};
