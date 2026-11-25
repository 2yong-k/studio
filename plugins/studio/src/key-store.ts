// Where the provider key is kept: the macOS Keychain on darwin, an owner-only file in the studio config folder
// elsewhere. Only `node:` modules, zod, errors.ts, home.ts and writeJsonAtomic at run time, so the session-start hook
// loads it without the drawing package.
import { constants, type Stats } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Exec, ExecIn } from './config.ts';
import { StudioError } from './errors.ts';
import { KEY_FILE } from './home.ts';
import { writeJsonAtomic } from './works/files.ts';

type KeyState = 'present' | 'absent' | 'unsafe';
export type KeyStore = {
  kind: 'keychain' | 'file';
  where(): string;
  state(): Promise<KeyState>;
  read(): Promise<string>;
  store(key: string): Promise<{ wasUnsafe: boolean }>;
};

const KeyFile = z.strictObject({
  schema: z.literal(1),
  key: z
    .string()
    .min(1)
    .regex(/^[^\r\n]+$/),
});

const KEYCHAIN_SERVICE = 'studio-fal';
const KEYCHAIN_ACCOUNT = 'studio';
// `security` exits 44 when the item does not exist.
const KEYCHAIN_NOT_FOUND = 44;
// The key is written by the system binary, never one found on PATH.
const SECURITY_BIN = '/usr/bin/security';
const NO_KEY = 'no fal key; add it with /plugin configure, then start a new session';
// The host's disk, not an injected platform: mode bits and owners exist only where the file really is.
const POSIX = process.platform !== 'win32';

// The darwin store never calls configDir, so the keychain needs no home folder. The file store asks for the folder on
// every call, so only a command that uses the key looks for it.
export function keyStore(platform: NodeJS.Platform, configDir: () => string, exec: Exec, execIn: ExecIn): KeyStore {
  if (platform === 'darwin') {
    return {
      kind: 'keychain',
      where: () => 'the keychain',
      state: async () => ((await hasProviderKey(exec)) ? 'present' : 'absent'),
      read: () => readProviderKey(exec),
      store: async (key) => {
        await storeProviderKey(key, execIn);
        return { wasUnsafe: false };
      },
    };
  }
  const where = (): string => join(configDir(), KEY_FILE);
  // async, so a home folder that cannot be found rejects like any other failure instead of throwing.
  return {
    kind: 'file',
    where,
    state: async () => fileState(where()),
    read: async () => readKeyFile(where()),
    store: async (key) => storeKeyFile(key, where()),
  };
}

export function keyUnsafeText(file: string): string {
  return `${file} can be read by other users; start a new session so the plugin rewrites it, or ask the owner to chmod 600 it`;
}

// A trailing line break is what a pasted key often brings along; any other line break would split the key.
function oneLine(key: string, details: { [k: string]: string }): string {
  const value = key.replace(/\r?\n$/, '');
  if (value === '' || /[\r\n]/.test(value)) {
    const why = 'the fal key must be one non-empty line; enter it again with /plugin configure';
    throw new StudioError('CONFIG_INVALID', why, details);
  }
  return value;
}

// The command's output and any exec error may hold the key, so none of it reaches the thrown error.
async function readProviderKey(exec: Exec): Promise<string> {
  let key = '';
  try {
    const args = ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'];
    const { stdout, code } = await exec('security', args);
    if (code === 0) key = stdout.trim();
  } catch {
    // Dropped unread on purpose; the KEY_MISSING below stands in for it.
  }
  if (key === '') {
    throw new StudioError('KEY_MISSING', NO_KEY, { service: KEYCHAIN_SERVICE, account: KEYCHAIN_ACCOUNT });
  }
  return key;
}

// Without -w the command prints the item's attributes, never the secret, so presence can be asked without reading it.
async function hasProviderKey(exec: Exec): Promise<boolean> {
  const args = ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT];
  let code: number;
  try {
    ({ code } = await exec('security', args));
  } catch (e) {
    const error = new StudioError('UNEXPECTED', 'could not run security', { service: KEYCHAIN_SERVICE });
    error.cause = e;
    throw error;
  }
  if (code === 0) return true;
  if (code === KEYCHAIN_NOT_FOUND) return false;
  throw new StudioError('UNEXPECTED', `security exited with code ${code}`, { code });
}

// `security -i` reads one command per stdin line, so the key never sits in the args a process list shows, and a line
// break in it would end the command early. Escaping `\` and `"` is enough inside the quotes: spaces, `$`, backticks
// and `'` are stored as given.
async function storeProviderKey(key: string, exec: ExecIn): Promise<void> {
  const value = oneLine(key, { service: KEYCHAIN_SERVICE });
  const quoted = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const line = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w "${quoted}"\n`;
  let code: number;
  try {
    ({ code } = await exec(SECURITY_BIN, ['-i'], line));
  } catch {
    // Dropped unread on purpose: an exec error may quote the stdin it was given.
    throw new StudioError('UNEXPECTED', 'could not run security', { service: KEYCHAIN_SERVICE });
  }
  if (code !== 0) {
    throw new StudioError('UNEXPECTED', `security exited with code ${code} while storing the key`, {
      service: KEYCHAIN_SERVICE,
      code,
    });
  }
}

const errnoOf = (e: unknown): string | undefined =>
  e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : undefined;

// An fs error names the path, never the file's content, so it is kept as the cause.
function fsFailure(e: unknown, file: string): unknown {
  const errno = errnoOf(e);
  if (errno === undefined) return e;
  const error = new StudioError('UNEXPECTED', `could not reach ${file}`, { file, errno });
  error.cause = e;
  return error;
}

// Another user could read it: on POSIX an owner other than this user, or any group or other bit. On Windows the
// profile ACL guards the file, as it does Claude Code's own credentials; mode bits there are not ACLs.
function othersCanRead(s: Stats): boolean {
  return POSIX && (s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0);
}

// Seen through lstat, a link is not a regular file either.
const unsafeStats = (s: Stats): boolean => !s.isFile() || othersCanRead(s);

// lstat only: a link is reported, never followed, and the file is never opened.
async function fileState(file: string): Promise<KeyState> {
  let s: Stats;
  try {
    s = await lstat(file);
  } catch (e) {
    if (errnoOf(e) === 'ENOENT') return 'absent';
    throw fsFailure(e, file);
  }
  return unsafeStats(s) ? 'unsafe' : 'present';
}

// POSIX opens without following a link or waiting for a FIFO's writer (O_NONBLOCK does nothing to a regular file), and
// checks the open file itself, so nothing can be swapped in between.
async function readKeyFile(file: string): Promise<string> {
  let text: string;
  try {
    text = POSIX ? await readOwnerOnly(file) : await readRegular(file);
  } catch (e) {
    if (e instanceof StudioError) throw e;
    const errno = errnoOf(e);
    if (errno === 'ENOENT') throw new StudioError('KEY_MISSING', NO_KEY, { file });
    if (errno === 'ELOOP') throw unsafe(file);
    throw fsFailure(e, file);
  }
  return keyOf(text, file);
}

async function readOwnerOnly(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (unsafeStats(await handle.stat())) throw unsafe(file);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function readRegular(file: string): Promise<string> {
  if (unsafeStats(await lstat(file))) throw unsafe(file);
  return readFile(file, 'utf8');
}

const unsafe = (file: string): StudioError => new StudioError('KEY_UNSAFE', keyUnsafeText(file), { file });

// A parser or schema message quotes the input, the key with it, so the error names the file and nothing else.
function keyOf(text: string, file: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid(file);
  }
  const parsed = KeyFile.safeParse(value);
  if (!parsed.success) throw invalid(file);
  return parsed.data.key;
}

const invalid = (file: string): StudioError =>
  new StudioError(
    'CONFIG_INVALID',
    'the stored key file is not valid; enter the key again with /plugin configure and start a new session',
    { file },
  );

// The temp file is born 0600 (umask only clears bits) and the rename replaces the old inode, a link included, so the
// new file is never readable by others; no chmod is needed.
async function storeKeyFile(key: string, file: string): Promise<{ wasUnsafe: boolean }> {
  const value = oneLine(key, { file });
  let old: Stats | null;
  try {
    old = await lstat(file);
  } catch (e) {
    if (errnoOf(e) !== 'ENOENT') throw fsFailure(e, file);
    old = null;
  }
  await writeJsonAtomic(file, KeyFile, { schema: 1, key: value }, { mode: 0o600 });
  return { wasUnsafe: old !== null && (old.isSymbolicLink() || othersCanRead(old)) };
}
