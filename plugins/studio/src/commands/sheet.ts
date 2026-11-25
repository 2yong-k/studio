import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StudioError } from '../errors.ts';
import { absolutePath, driveHint } from '../home.ts';
import { makeSheet } from '../make/index.ts';
import { loadBriefHashed } from '../works/index.ts';
import { type AppCtx, briefCtxOf, type Command, errno, parse, usageError, workDirOf } from './shared.ts';

const USAGE = 'sheet <absolute-file>... [--every <ms>]';
const DEFAULT_EVERY_MS = 1000;
const MS = /^[1-9][0-9]*$/;

type Place = { work: string; rel: string };

async function realFile(file: string): Promise<string> {
  return realpath(resolve(file)).catch((e: unknown) => {
    if (errno(e, 'ENOENT')) {
      throw new StudioError('NOT_FOUND', `no file at ${file}`, { file });
    }
    throw e;
  });
}

// Both sides are real paths, so a symlink cannot place a file from elsewhere inside a work.
function placeOf(root: string, file: string): Place {
  const rel = relative(root, file);
  const [work, ...rest] = rel.split(sep);
  if (isAbsolute(rel) || work === undefined || work === '..' || rest.length === 0) {
    throw new StudioError('USAGE', `${file} is not inside a work folder under ${root}`, { file });
  }
  return { work, rel: rest.join('/') };
}

const isFilm = (p: Place): boolean => p.rel === 'build/candidate.mp4' || p.rel.startsWith('final/');

// The film's cut boundaries. A raw clip or an input is one cut or none, so they would flag meaningless times there,
// and a sheet of raws needs no brief at all.
async function marksOf(app: AppCtx, workDir: string, places: readonly Place[]): Promise<number[]> {
  if (!places.every(isFilm)) return [];
  const { brief } = await loadBriefHashed(await briefCtxOf(app, workDir));
  if (brief.kind !== 'video') return [];
  const marks: number[] = [];
  let t = 0;
  for (const cut of brief.cuts.slice(0, -1)) {
    t += cut.durationMs;
    marks.push(t);
  }
  return marks;
}

async function workOf(app: AppCtx, files: readonly string[]): Promise<{ work: string; places: Place[] }> {
  const root = await realFile(app.worksRoot);
  const places = files.map((f) => placeOf(root, f));
  const works = new Set(places.map((p) => p.work));
  const [work, ...others] = works;
  if (work === undefined || others.length > 0) {
    throw new StudioError('USAGE', 'sheet takes files from one work at a time', { works: [...works] });
  }
  return { work, places };
}

export const sheet: Command = async (args, app) => {
  const { values, positionals } = parse(args, { every: { type: 'string' } }, USAGE);
  if (positionals.length === 0) throw usageError(USAGE, 'give at least one file');
  if (values.every !== undefined && !MS.test(values.every)) throw usageError(USAGE, '--every is a positive ms integer');
  const everyMs = values.every === undefined ? DEFAULT_EVERY_MS : Number.parseInt(values.every, 10);
  // The cwd is wherever the shell running the command is, not the work, so a relative path could name another file.
  const loose = positionals.find((p) => !absolutePath(p, app.platform));
  if (loose !== undefined) {
    throw usageError(USAGE, `${loose} is relative; pass an absolute path${driveHint(app.platform)}`);
  }
  const files = await Promise.all(positionals.map(realFile));
  const { work, places } = await workOf(app, files);
  const workDir = await workDirOf(app, work);
  const marksMs = await marksOf(app, workDir, places);
  const sheets = await makeSheet(files, { repoRoot: app.repoRoot, everyMs, marksMs, outDir: join(workDir, 'review') });
  return { work, sheets, everyMs, marksMs };
};
