import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioError } from '../errors.ts';
import { runFfmpeg } from './ffmpeg.ts';
import { isMissingFile } from './files.ts';
import { probe } from './probe.ts';

const WINDOW_MS = 100;
const THRESHOLD_DB = -35;
const JOIN_GAP_MS = 300;
const MIN_SEGMENT_MS = 200;
const MEASURE_RATE = 16_000;

type Segment = { startMs: number; endMs: number };
type Speech = { windowMs: number; thresholdDb: number; segments: Segment[] };

type Window = { startMs: number; loud: boolean };

const TIME_LINE = /^frame:\d+\s+pts:-?\d+\s+pts_time:(-?\d+(?:\.\d+)?)$/;
const LEVEL_LINE = /^lavfi\.astats\.Overall\.RMS_level=(-?inf|-?\d+(?:\.\d+)?)$/;

// ametadata prints a `pts_time` line and then the level line for every window.
function windowsOf(text: string): Window[] {
  const windows: Window[] = [];
  let startMs: number | null = null;
  for (const line of text.split('\n').map((l) => l.trim())) {
    const time = TIME_LINE.exec(line)?.[1];
    if (time !== undefined) {
      startMs = Math.round(Number(time) * 1000);
      continue;
    }
    const level = LEVEL_LINE.exec(line)?.[1];
    if (level === undefined) continue;
    if (startMs === null) throw new Error(`ffmpeg printed a level before any time: ${line}`);
    // A silent window prints -inf; Number('-inf') is NaN, which is not above the threshold either.
    windows.push({ startMs, loud: Number(level) > THRESHOLD_DB });
    startMs = null;
  }
  return windows;
}

// Runs of loud windows are segments; a gap up to JOIN_GAP_MS joins two of them, and a result shorter than MIN_SEGMENT_MS is noise.
function segmentsOf(windows: readonly Window[]): Segment[] {
  const runs: Segment[] = [];
  for (const w of windows) {
    if (!w.loud) continue;
    const last = runs.at(-1);
    if (last !== undefined && w.startMs - last.endMs <= JOIN_GAP_MS) last.endMs = w.startMs + WINDOW_MS;
    else runs.push({ startMs: w.startMs, endMs: w.startMs + WINDOW_MS });
  }
  return runs.filter((s) => s.endMs - s.startMs >= MIN_SEGMENT_MS);
}

const escapeChars = (s: string, chars: string): string =>
  [...s].map((c) => (chars.includes(c) ? `\\${c}` : c)).join('');

// The path sits in a filter option inside a filtergraph, so it is escaped for both: the option parser (':' splits
// options) first, then the graph parser (',' ';' '[' ']' '=' and quotes).
const filterValue = (path: string): string => escapeChars(escapeChars(path, "\\':"), "\\',;[]=");

async function levelsOf(out: string, file: string): Promise<string> {
  try {
    return await readFile(out, 'utf8');
  } catch (e) {
    // An empty list would pass for a silent recording, so a missing measurement is an error.
    if (isMissingFile(e)) throw new StudioError('UNEXPECTED', `ffmpeg wrote no level file for ${file}`, { file });
    throw e;
  }
}

export async function speechSegments(file: string): Promise<Speech> {
  const info = await probe(file);
  if (!info.hasAudio) throw new StudioError('USAGE', `${file} has no sound track`, { file });
  const dir = await mkdtemp(join(tmpdir(), 'studio-speech-measure-'));
  try {
    const out = join(dir, 'levels.txt');
    const filters = [
      `aresample=${MEASURE_RATE}`,
      `asetnsamples=n=${(MEASURE_RATE * WINDOW_MS) / 1000}`,
      'astats=metadata=1:reset=1',
      `ametadata=print:key=lavfi.astats.Overall.RMS_level:file=${filterValue(out)}`,
    ];
    await runFfmpeg(['-nostats', '-i', file, '-vn', '-af', filters.join(','), '-f', 'null', '-']);
    const windows = windowsOf(await levelsOf(out, file));
    return { windowMs: WINDOW_MS, thresholdDb: THRESHOLD_DB, segments: segmentsOf(windows) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
