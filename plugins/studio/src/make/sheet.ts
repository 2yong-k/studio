import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { type Canvas, createCanvas, type Image, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import { StudioError } from '../errors.ts';
import { DEFAULT_FONT, registerBuiltinFonts } from './draw/fonts.ts';
import { runFfmpeg } from './ffmpeg.ts';
import { atomically, fileSafe, isMissingFile } from './files.ts';
import { probe } from './probe.ts';

export type SheetOptions = {
  repoRoot: string;
  everyMs: number;
  marksMs: readonly number[];
  outDir: string;
};

const COLUMNS = 4;
const MAX_CELLS = 24;
// Ten sheets of 24 per video; beyond that the grid is too fine to review, and a tiny step on a long clip would
// otherwise build millions of cells before the first sheet.
const MAX_VIDEO_CELLS = 240;
// A sheet takes its picture box from its first picture, so a portrait clip is not shrunk into a landscape cell.
type PictureBox = { w: number; h: number };
const LANDSCAPE: PictureBox = { w: 320, h: 180 };
const PORTRAIT: PictureBox = { w: 180, h: 320 };
// Frames are taken at twice the box's long side either way, so one size serves both boxes.
const FRAME_FIT = 2 * LANDSCAPE.w;
const LABEL_H = 40;
const GAP = 12;
const LABEL_PAD = 6;
const LABEL_PX = 14;
const LABEL_LINE = LABEL_PX + 4;
const GROUND = '#202124';
const IMAGE_GROUND = '#000000';
const TEXT = '#ffffff';
const MARK = '#f2b705';
const MARK_TEXT = '#202124';
const MARK_TAG = 'cut';
const MARK_BORDER = 3;
const JPEG_QUALITY = 90;
const IMAGE_GROUP = 'images';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm']);

// atMs is null for a still image, which has no time to show.
type Cell = { file: string; atMs: number | null; marked: boolean };
type Group = { name: string; cells: Cell[] };

const isNonNegativeInt = (n: number): boolean => Number.isInteger(n) && n >= 0;

function validate(files: readonly string[], o: SheetOptions): void {
  if (files.length === 0) throw new StudioError('USAGE', 'sheet needs at least one file', {});
  if (!isNonNegativeInt(o.everyMs) || o.everyMs === 0) {
    throw new StudioError('USAGE', 'every must be a positive integer in ms', { everyMs: o.everyMs });
  }
  const bad = o.marksMs.find((m) => !isNonNegativeInt(m));
  if (bad !== undefined) throw new StudioError('USAGE', 'marks must be non-negative integers in ms', { mark: bad });
}

// A regular grid plus the cut boundaries inside the clip; a boundary on a grid time still counts as flagged.
function frameTimes(durationMs: number, o: SheetOptions): { atMs: number; marked: boolean }[] {
  const times = new Map<number, boolean>();
  for (let t = 0; t < durationMs; t += o.everyMs) times.set(t, false);
  for (const m of o.marksMs) if (m < durationMs) times.set(m, true);
  return [...times.entries()].sort((a, b) => a[0] - b[0]).map(([atMs, marked]) => ({ atMs, marked }));
}

// Only a missing input is NOT_FOUND; any other failure keeps its own message and error as the cause.
function unreadable(file: string, e: unknown): StudioError {
  const error = new StudioError('UNEXPECTED', e instanceof Error ? e.message : String(e), { file });
  error.cause = e;
  return error;
}

const notFound = (file: string): StudioError => new StudioError('NOT_FOUND', `no file at ${file}`, { file });

async function assertExists(file: string): Promise<void> {
  try {
    await stat(file);
  } catch (e) {
    throw isMissingFile(e) ? notFound(file) : unreadable(file, e);
  }
}

function assertCellCount(file: string, cells: number): void {
  if (cells > MAX_VIDEO_CELLS) {
    throw new StudioError('USAGE', `${file} would need ${cells} cells; at most ${MAX_VIDEO_CELLS} per video`, {
      file,
      cells,
      max: MAX_VIDEO_CELLS,
    });
  }
}

async function videoGroup(file: string, o: SheetOptions): Promise<Group> {
  const info = await probe(file).catch((e: unknown) => {
    throw unreadable(file, e);
  });
  // A film's audio can outlast its last frame, and no frame exists past the picture.
  const durationMs = info.videoDurationMs ?? info.durationMs;
  if (!info.hasVideo || durationMs === null || durationMs <= 0) {
    throw new StudioError('USAGE', `video has no duration or no video stream: ${file}`, { file });
  }
  // The grid is counted before it is built, so a tiny step on a long clip fails without allocating it.
  assertCellCount(file, Math.ceil(durationMs / o.everyMs));
  const times = frameTimes(durationMs, o);
  assertCellCount(file, times.length);
  const name = fileSafe('video', basename(file, extname(file)));
  return { name, cells: times.map((t) => ({ file, ...t })) };
}

async function groupsOf(files: readonly string[], o: SheetOptions): Promise<Group[]> {
  const groups: Group[] = [];
  let images: Group | null = null;
  for (const file of files) {
    const ext = extname(file).toLowerCase();
    if (!IMAGE_EXT.has(ext) && !VIDEO_EXT.has(ext)) {
      throw new StudioError('USAGE', `unsupported file type: ${file}`, { file });
    }
    await assertExists(file);
    if (IMAGE_EXT.has(ext)) {
      if (images === null) {
        images = { name: IMAGE_GROUP, cells: [] };
        groups.push(images);
      }
      images.cells.push({ file, atMs: null, marked: false });
    } else {
      groups.push(await videoGroup(file, o));
    }
  }
  // Two groups with one name would write the same sheet files.
  const names = new Set<string>();
  for (const { name } of groups) {
    if (names.has(name)) throw new StudioError('USAGE', `two inputs would write sheet-${name}-*.jpg`, { name });
    names.add(name);
  }
  return groups;
}

export function timeLabel(ms: number): string {
  const pad = (n: number, width: number): string => String(n).padStart(width, '0');
  return `${pad(Math.floor(ms / 60_000), 2)}:${pad(Math.floor((ms % 60_000) / 1000), 2)}.${pad(ms % 1000, 3)}`;
}

function fitText(ctx: SKRSContext2D, text: string, maxPx: number): string {
  if (ctx.measureText(text).width <= maxPx) return text;
  let kept = [...text];
  while (kept.length > 1 && ctx.measureText(`${kept.join('')}…`).width > maxPx) kept = kept.slice(0, -1);
  return `${kept.join('')}…`;
}

// Cells are decoded one at a time so a sheet never holds 24 full-size frames in memory.
async function cellImage(cell: Cell, tmp: string, index: number): Promise<Image> {
  if (cell.atMs === null) {
    try {
      return await loadImage(await readFile(cell.file));
    } catch (e) {
      throw isMissingFile(e) ? notFound(cell.file) : unreadable(cell.file, e);
    }
  }
  const out = join(tmp, `${index}.png`);
  await runFfmpeg([
    ...['-ss', (cell.atMs / 1000).toFixed(3), '-i', cell.file],
    ...['-frames:v', '1', '-vf', `scale=${FRAME_FIT}:${FRAME_FIT}:force_original_aspect_ratio=decrease`],
    out,
  ]);
  // ffmpeg exits cleanly without writing when the time lies past the last frame, which is the only ENOENT here.
  const bytes = await readFile(out).catch((e: unknown) => {
    if (!isMissingFile(e)) throw e;
    throw new StudioError('NOT_FOUND', `no frame at ${cell.atMs} ms: ${cell.file}`, {
      file: cell.file,
      atMs: cell.atMs,
    });
  });
  await rm(out, { force: true });
  return loadImage(bytes);
}

function drawLabel(ctx: SKRSContext2D, cell: Cell, box: PictureBox, x: number, y: number): void {
  ctx.font = `${LABEL_PX}px "${DEFAULT_FONT}"`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = TEXT;
  const top = y + box.h + LABEL_PAD;
  if (cell.atMs !== null) ctx.fillText(timeLabel(cell.atMs), x, top);
  ctx.fillText(fitText(ctx, basename(cell.file), box.w), x, cell.atMs === null ? top : top + LABEL_LINE);
  if (!cell.marked) return;
  const tagW = ctx.measureText(MARK_TAG).width + LABEL_PAD * 2;
  ctx.fillStyle = MARK;
  ctx.fillRect(x + box.w - tagW, top, tagW, LABEL_LINE);
  ctx.fillStyle = MARK_TEXT;
  ctx.fillText(MARK_TAG, x + box.w - tagW + LABEL_PAD, top + 2);
}

function drawCell(ctx: SKRSContext2D, cell: Cell, image: Image, box: PictureBox, x: number, y: number): void {
  ctx.fillStyle = IMAGE_GROUND;
  ctx.fillRect(x, y, box.w, box.h);
  const scale = Math.min(box.w / image.width, box.h / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  ctx.drawImage(image, x + (box.w - w) / 2, y + (box.h - h) / 2, w, h);
  if (cell.marked) {
    ctx.strokeStyle = MARK;
    ctx.lineWidth = MARK_BORDER;
    ctx.strokeRect(x + MARK_BORDER / 2, y + MARK_BORDER / 2, box.w - MARK_BORDER, box.h - MARK_BORDER);
  }
  drawLabel(ctx, cell, box, x, y);
}

async function drawSheet(cells: readonly Cell[], tmp: string): Promise<Canvas> {
  const [first, ...rest] = cells;
  if (first === undefined) throw new StudioError('UNEXPECTED', 'a sheet needs at least one cell', {});
  const firstImage = await cellImage(first, tmp, 0);
  const box = firstImage.height > firstImage.width ? PORTRAIT : LANDSCAPE;
  const rows = Math.ceil(cells.length / COLUMNS);
  const canvas = createCanvas(COLUMNS * box.w + (COLUMNS + 1) * GAP, rows * (box.h + LABEL_H) + (rows + 1) * GAP);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = GROUND;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const at = (i: number): [number, number] => [
    GAP + (i % COLUMNS) * (box.w + GAP),
    GAP + Math.floor(i / COLUMNS) * (box.h + LABEL_H + GAP),
  ];
  drawCell(ctx, first, firstImage, box, ...at(0));
  for (const [k, cell] of rest.entries()) {
    const i = k + 1;
    drawCell(ctx, cell, await cellImage(cell, tmp, i), box, ...at(i));
  }
  return canvas;
}

export async function makeSheet(files: readonly string[], o: SheetOptions): Promise<string[]> {
  validate(files, o);
  const groups = await groupsOf(files, o);
  await registerBuiltinFonts(o.repoRoot);
  await mkdir(o.outDir, { recursive: true });
  const tmp = await mkdtemp(join(tmpdir(), 'studio-sheet-'));
  const written: string[] = [];
  try {
    for (const group of groups) {
      for (let first = 0, n = 1; first < group.cells.length; first += MAX_CELLS, n++) {
        const canvas = await drawSheet(group.cells.slice(first, first + MAX_CELLS), tmp);
        const path = join(o.outDir, `sheet-${group.name}-${n}.jpg`);
        const jpeg = await canvas.encode('jpeg', JPEG_QUALITY);
        await atomically(path, (t) => writeFile(t, jpeg));
        written.push(path);
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return written;
}
