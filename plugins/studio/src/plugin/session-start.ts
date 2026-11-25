import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { configPath, defaultExec, type Env, execIn, StudioConfig } from '../config.ts';
import { StudioError } from '../errors.ts';
import { absolutePath, driveHint, expandTilde, NO_HOME_FOLDER, pathFor, userHome } from '../home.ts';
import { type KeyStore, keyStore } from '../key-store.ts';
import { writeJsonAtomic } from '../works/files.ts';

export type SessionIo = {
  platform: NodeJS.Platform;
  homedir: () => string;
  // The store for the config folder: the keychain on macOS, the owner-only file elsewhere.
  keyStore: (configDir: string) => KeyStore;
  writeConfig: (path: string, cfg: StudioConfig) => Promise<void>;
  mkdir: (p: string) => Promise<void>;
};

const DEFAULT_STUDIO_HOME = '~/studio-works';
const UNSAFE_WARNING =
  'the stored key file was readable by others; it is now owner-only — rotate the key if others use this machine';

// os.homedir throws when the variable is unset and the user has no passwd entry, which is the same missing home.
function homedirOf(io: SessionIo): () => string {
  return () => {
    try {
      return io.homedir();
    } catch (e) {
      const error = new StudioError('UNEXPECTED', NO_HOME_FOLDER);
      error.cause = e;
      throw error;
    }
  };
}

// The option may arrive as typed, `~/` and all, while the CLI takes only an absolute path.
function studioFolder(option: string | undefined, home: string, platform: NodeJS.Platform): string {
  const raw = option === undefined || option === '' ? DEFAULT_STUDIO_HOME : option;
  const folder = expandTilde(raw, home, platform);
  if (!absolutePath(folder, platform)) {
    const why = `the studio folder must be an absolute path or start with ~/${driveHint(platform)}`;
    throw new StudioError('CONFIG_INVALID', `${why}; set it with /plugin configure`, { studio_home: raw });
  }
  return folder;
}

// The config is written on every start, before the folder and key steps can fail: without it every CLI command stops
// with CONFIG_INVALID. An empty key option leaves the stored key alone. A warning is for the user to act on, not a
// failure: the key is stored by then.
export async function sessionStart(
  env: Env,
  io: SessionIo,
): Promise<{ home: string; keyStored: boolean; warnings: string[] }> {
  const fallback = homedirOf(io);
  const user = userHome(env, io.platform, fallback);
  const file = configPath(env, io.platform, fallback);
  if (user === null || file === null) throw new StudioError('UNEXPECTED', NO_HOME_FOLDER);
  const home = studioFolder(env.CLAUDE_PLUGIN_OPTION_STUDIO_HOME, user, io.platform);
  const configDir = pathFor(io.platform).dirname(file);
  await io.mkdir(configDir);
  await io.writeConfig(file, { schema: 1, home });
  await io.mkdir(home);
  const key = env.CLAUDE_PLUGIN_OPTION_FAL_KEY;
  // The store drops this same trailing line break; a key of nothing else is empty.
  if (key === undefined || key.replace(/\r?\n$/, '') === '') return { home, keyStored: false, warnings: [] };
  const { wasUnsafe } = await io.keyStore(configDir).store(key);
  return { home, keyStored: true, warnings: wasUnsafe ? [UNSAFE_WARNING] : [] };
}

function errorLine(e: unknown): string {
  let text = String(e);
  if (e instanceof StudioError) text = `${e.code}: ${e.message}`;
  else if (e instanceof Error) text = `${e.name}: ${e.message}`;
  return text.replace(/\s+/g, ' ').trim();
}

// A SessionStart hook's stdout goes into the conversation, so a run says nothing there. A failure or a warning is one
// stderr line each, with exit 1 so Claude Code shows it.
export async function run(): Promise<void> {
  try {
    const { warnings } = await sessionStart(process.env, {
      platform: process.platform,
      homedir,
      keyStore: (dir) => keyStore(process.platform, () => dir, defaultExec, execIn(process.env)),
      writeConfig: (path, cfg) => writeJsonAtomic(path, StudioConfig, cfg),
      mkdir: async (p) => {
        await mkdir(p, { recursive: true });
      },
    });
    for (const warning of warnings) process.stderr.write(`studio: ${warning}\n`);
    if (warnings.length > 0) process.exitCode = 1;
  } catch (e) {
    process.stderr.write(`studio: ${errorLine(e)}\n`);
    process.exitCode = 1;
  }
}
