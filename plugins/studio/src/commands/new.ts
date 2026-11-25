import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type JsonValue, StudioError } from '../errors.ts';
import { type AppCtx, type Command, errno, parse, single, usageError } from './shared.ts';

const USAGE = 'new <name> --kind image|video';
const NAME = /^[a-z0-9-]+$/;

const pad = (n: number): string => String(n).padStart(2, '0');

// Local, not UTC: a work started at 03:00 local time, ahead of UTC, belongs to that local day.
export const localDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const localTime = (d: Date): string => `${pad(d.getHours())}${pad(d.getMinutes())}`;

export async function createWork(app: AppCtx, name: string, now: Date): Promise<{ work: string; workDir: string }> {
  const work = `${localDate(now)}-${name}`;
  const workDir = join(app.worksRoot, work);
  await mkdir(app.worksRoot, { recursive: true });
  // Not recursive, so an existing folder fails instead of being reused.
  await mkdir(workDir).catch((e: unknown) => {
    if (errno(e, 'EEXIST')) {
      throw new StudioError('WORK_EXISTS', `work ${work} already exists`, { work });
    }
    throw e;
  });
  await mkdir(join(workDir, 'inputs'));
  return { work, workDir };
}

// A starting shape for Claude to fill; the empty intent and mood keep it from passing validation as it is.
function template(work: string, kind: 'image' | 'video'): JsonValue {
  const common = { schema: 1, work, kind, intent: '', mood: '' };
  return kind === 'image'
    ? { ...common, frame: { width: 1080, height: 1080 }, elements: [], layout: [] }
    : { ...common, frame: { width: 1080, height: 1920, fps: 24 }, elements: [], cuts: [] };
}

export const newWork: Command = async (args, app) => {
  const { values, positionals } = parse(args, { kind: { type: 'string' } }, USAGE);
  const name = single(positionals, USAGE);
  if (!NAME.test(name)) throw usageError(USAGE, `name must match ${NAME.source}`);
  const kind = values.kind;
  if (kind !== 'image' && kind !== 'video') throw usageError(USAGE, '--kind must be image or video');
  const { work, workDir } = await createWork(app, name, app.now());
  const brief = join(workDir, 'brief.json');
  await writeFile(brief, `${JSON.stringify(template(work, kind), null, 2)}\n`, { flag: 'wx' });
  return { work, dir: workDir, brief };
};
