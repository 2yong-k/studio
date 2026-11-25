import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { type FileHandle, lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { z } from 'zod';
import { StudioError } from '../errors.ts';

type Where = { file: string; line?: number };
export type Issue = { path: string; message: string };

const PID = /^\d+$/;

function isErrno(e: unknown, code: string): boolean {
  return e instanceof Error && 'code' in e && e.code === code;
}

function missing(e: unknown, path: string): unknown {
  return isErrno(e, 'ENOENT') ? new StudioError('NOT_FOUND', `no file at ${path}`, { file: path }) : e;
}

function invalid(code: 'BRIEF_INVALID' | 'UNEXPECTED', where: Where, issues: Issue[]): StudioError {
  const at = where.line === undefined ? where.file : `${where.file}:${where.line}`;
  return new StudioError(code, `${at} does not match its schema`, { ...where, issues });
}

// Only the path and Zod's message leave; `input` would copy the user's raw value into the error.
export function issueList(issues: readonly { path: readonly PropertyKey[]; message: string }[]): Issue[] {
  return issues.map((i) => ({ path: i.path.map((seg) => String(seg)).join('.'), message: i.message }));
}

function validate<S extends z.ZodType>(
  schema: S,
  value: unknown,
  code: 'BRIEF_INVALID' | 'UNEXPECTED',
  where: Where,
): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw invalid(code, where, issueList(result.error.issues));
}

function parseText<S extends z.ZodType>(text: string, schema: S, where: Where): z.infer<S> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid('BRIEF_INVALID', where, [{ path: '', message: 'invalid JSON' }]);
  }
  return validate(schema, value, 'BRIEF_INVALID', where);
}

// One write per call so an O_APPEND line is never split by another writer; a short write is a torn record.
async function writeAndClose(handle: FileHandle, path: string, text: string): Promise<void> {
  try {
    const data = Buffer.from(text, 'utf8');
    const { bytesWritten } = await handle.write(data);
    if (bytesWritten !== data.length) {
      throw new StudioError('UNEXPECTED', `short write to ${path}`, { file: path, bytesWritten, length: data.length });
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJson<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
  const text = await readFile(path, 'utf8').catch((e: unknown) => {
    throw missing(e, path);
  });
  return parseText(text, schema, { file: path });
}

// One read for both, so the value parsed is the exact bytes the hash names, even if the file changes in between.
export async function readJsonHashed<S extends z.ZodType>(
  path: string,
  schema: S,
): Promise<{ value: z.infer<S>; sha256: string }> {
  const bytes = await readFile(path).catch((e: unknown) => {
    throw missing(e, path);
  });
  const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  return { value: parseText(bytes.toString('utf8'), schema, { file: path }), sha256 };
}

export type ReplaceDeps = {
  platform?: NodeJS.Platform;
  rename?: (from: string, to: string) => Promise<void>;
  wait?: (ms: number) => Promise<void>;
};

const HELD = ['EPERM', 'EACCES', 'EBUSY'];
const HELD_RETRIES = 10;
const HELD_WAIT_MS = 100;

// Windows refuses to replace a file another program (a viewer, a virus scanner) holds open, and such holds are often
// brief. A failure leaves `tmp` to the caller.
export async function replaceFile(tmp: string, path: string, deps: ReplaceDeps = {}): Promise<void> {
  const { platform = process.platform, rename: move = rename, wait = delay } = deps;
  for (let retries = 0; ; retries += 1) {
    try {
      await move(tmp, path);
      return;
    } catch (e) {
      const errno = platform === 'win32' ? HELD.find((code) => isErrno(e, code)) : undefined;
      if (errno === undefined) throw e;
      if (retries === HELD_RETRIES) {
        const why = `${path} is open in another program; close it and run the command again`;
        // A folder or a read-only file in the way ends here too, as EPERM; only EBUSY surely means a holder.
        throw new StudioError('FILE_BUSY', why, { file: path, errno });
      }
    }
    await wait(HELD_WAIT_MS);
  }
}

export async function writeJsonAtomic<S extends z.ZodType>(
  path: string,
  schema: S,
  value: z.infer<S>,
  opts: { mode?: number } = {},
): Promise<void> {
  const parsed = validate(schema, value, 'UNEXPECTED', { file: path });
  const tmp = join(dirname(path), `${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeAndClose(await open(tmp, 'wx', opts.mode ?? 0o666), tmp, `${JSON.stringify(parsed, null, 2)}\n`);
    await replaceFile(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

export async function appendJsonl<S extends z.ZodType>(path: string, schema: S, value: z.infer<S>): Promise<void> {
  const parsed = validate(schema, value, 'UNEXPECTED', { file: path });
  await writeAndClose(await open(path, 'a'), path, `${JSON.stringify(parsed)}\n`);
}

// A missing log means nothing was recorded yet; any other read failure must not look like an empty log.
export async function readJsonl<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>[]> {
  const text = await readFile(path, 'utf8').catch((e: unknown) => {
    if (isErrno(e, 'ENOENT')) return '';
    throw e;
  });
  const rows: z.infer<S>[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (line.trim() !== '') rows.push(parseText(line, schema, { file: path, line: i + 1 }));
  }
  return rows;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  try {
    await pipeline(createReadStream(path), async (chunks: AsyncIterable<Buffer>) => {
      for await (const chunk of chunks) hash.update(chunk);
    });
  } catch (e) {
    throw missing(e, path);
  }
  return `sha256:${hash.digest('hex')}`;
}

// The holder may release between our failed open and this read; it is still held as far as we know.
async function lockHolder(lockPath: string): Promise<number | null> {
  const text = await readFile(lockPath, 'utf8').catch((e: unknown) => {
    if (isErrno(e, 'ENOENT')) return '';
    throw e;
  });
  const pid = text.trim();
  return PID.test(pid) ? Number.parseInt(pid, 10) : null;
}

// A stale lock is left for the user to judge; removing it automatically could let two runs spend at once.
export async function withWorkLock<T>(workDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = join(workDir, '.lock');
  const handle = await open(lockPath, 'wx').catch(async (e: unknown) => {
    if (!isErrno(e, 'EEXIST')) throw e;
    const why = `${workDir} is locked by another studio command: ${lockPath}`;
    throw new StudioError('LOCKED', why, { pid: await lockHolder(lockPath) });
  });
  try {
    await writeAndClose(handle, lockPath, String(process.pid));
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}

function isWithin(root: string | null, target: string): boolean {
  if (root === null) return false;
  const r = relative(root, target);
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

// A missing root contains nothing, so it cannot vouch for any path.
async function realRoot(root: string): Promise<string | null> {
  return realpath(root).catch((e: unknown) => {
    if (isErrno(e, 'ENOENT')) return null;
    throw e;
  });
}

// Both sides are realpath'd so a symlink cannot point out of a root and `/a/b2` never counts as inside `/a/b`.
export async function resolveInside(roots: readonly string[], base: string, rel: string): Promise<string> {
  const target = await realpath(resolve(base, rel)).catch((e: unknown) => {
    throw missing(e, rel);
  });
  const realRoots = await Promise.all(roots.map(realRoot));
  if (realRoots.some((root) => isWithin(root, target))) return target;
  throw new StudioError('BRIEF_INVALID', `path is outside the allowed folders: ${rel}`, { rel });
}

// resolveInside follows a linked root, so a caller that trusts a folder by its name must first know it is not a link.
export async function isLink(path: string): Promise<boolean> {
  return lstat(path).then(
    (s) => s.isSymbolicLink(),
    (e: unknown) => {
      if (isErrno(e, 'ENOENT')) return false;
      throw e;
    },
  );
}
