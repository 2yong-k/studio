import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { StudioError } from '../errors.ts';
import { replaceFile } from '../works/index.ts';

// Ids come from the brief and become file names, so one that names a path would write outside preview/.
export function fileSafe(kind: string, id: string): string {
  if (id === '.' || id === '..' || /[\\/\0\r\n]/.test(id)) {
    throw new StudioError('BRIEF_INVALID', `${kind} id ${JSON.stringify(id)} cannot be used as a file name`, { id });
  }
  return id;
}

export function isMissingFile(e: unknown): boolean {
  return e instanceof Error && 'code' in e && e.code === 'ENOENT';
}

// A sibling name unique to this call, so two writers (same process or not) never share a scratch file.
export function scratchName(path: string, ext: string): string {
  return `${path}.${process.pid}.${randomBytes(6).toString('hex')}.${ext}`;
}

// A reader (the fingerprint, an upload) must never see half a file, so each output lands by rename.
export async function atomically(path: string, produce: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = scratchName(path, 'tmp');
  try {
    await produce(tmp);
    await replaceFile(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}
