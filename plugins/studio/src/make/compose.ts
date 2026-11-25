import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { type Image, loadImage } from '@napi-rs/canvas';
import { StudioError } from '../errors.ts';
import {
  type AttemptView,
  acceptedOf,
  attempts,
  type Box,
  type Brief,
  type BriefCtx,
  briefPath,
  type Cut,
  drawSvg,
  type Element,
  elementInputHash,
  type FileElement,
  type GenerateImage,
  type GenerateVideo,
  isVideoLayer,
  type Rect,
  readSvg,
  SVG_FILE,
  visibleSpanMs,
} from '../works/index.ts';
import { type CutPlan, cutTimeMs, planCuts } from './cuts.ts';
import { fitStill } from './draw/fit.ts';
import { renderFrame, textChecks } from './draw/scene.ts';
import type { TextWarning } from './draw/text.ts';
import { runFfmpeg } from './ffmpeg.ts';
import { atomically, fileSafe, isMissingFile, scratchName } from './files.ts';
import { probe } from './probe.ts';

type VideoBrief = Extract<Brief, { kind: 'video' }>;
type Generated = GenerateImage | GenerateVideo;
type Raws = ReadonlyMap<string, string>;

// What a layer's audio is mixed at; the final loudness pass runs on the mix, so this only has to be common.
const SAMPLE_RATE = 48_000;
const TARGET_LUFS = -14;
const MUSIC_FADE_MS = 1000;
// How far a clip sound may play on past its span, fading out, so the next cut's quiet first moments are not a gap.
const BRIDGE_MS = 300;

const boxesOf = (brief: Brief): Box[] =>
  brief.kind === 'image' ? brief.layout : brief.cuts.flatMap((cut) => cut.layout);

// A keyframe is never composed (only the video made from it is), so it has no raw to pick here.
function placedGenerated(brief: Brief): Generated[] {
  const placed = new Set(boxesOf(brief).map((b) => b.element));
  return brief.elements.filter((e): e is Generated => e.method === 'generate' && placed.has(e.id));
}

const isAccepted = (v: AttemptView): boolean => v.last.state === 'settled' && v.last.outcome === 'accepted';

async function rawFile(ctx: BriefCtx, view: AttemptView): Promise<string> {
  const rel = view.last.file;
  if (rel === null) {
    throw new StudioError('UNEXPECTED', `accepted attempt ${view.attempt} names no file`, { attempt: view.attempt });
  }
  const abs = join(ctx.workDir, rel);
  try {
    await stat(abs);
  } catch (e) {
    if (!isMissingFile(e)) throw e;
    throw new StudioError('NOT_FOUND', `${view.element} attempt ${view.attempt} has no file at ${rel}`, {
      element: view.element,
      attempt: view.attempt,
      file: rel,
    });
  }
  return abs;
}

async function usedRaw(
  ctx: BriefCtx,
  brief: Brief,
  views: readonly AttemptView[],
  el: Generated,
  n: number,
): Promise<string> {
  const attempt = `${brief.work}/${el.id}/${n}`;
  const view = views.find((v) => v.attempt === attempt);
  if (view === undefined || !isAccepted(view)) {
    const why = view === undefined ? 'there is no such attempt' : 'it was not accepted';
    throw new StudioError('USAGE', `--use ${el.id}=${n}: ${why} (${attempt})`, { element: el.id, attempt });
  }
  return rawFile(ctx, view);
}

// A video whose keyframe was re-made has no current fingerprint at all, which reads the same as a stale raw.
async function currentHash(ctx: BriefCtx, brief: Brief, el: Generated): Promise<string | null> {
  try {
    return await elementInputHash(ctx, brief, el.id);
  } catch (e) {
    if (e instanceof StudioError && e.code === 'KEYFRAME_NOT_CONFIRMED') return null;
    throw e;
  }
}

async function currentRaw(ctx: BriefCtx, brief: Brief, views: readonly AttemptView[], el: Generated): Promise<string> {
  const hash = await currentHash(ctx, brief, el);
  const view = hash === null ? null : acceptedOf(views, el.id, hash);
  if (view === null) {
    throw new StudioError(
      'RAW_STALE',
      `${el.id} has no accepted attempt for its current inputs; make it again or pass --use ${el.id}=<n>`,
      { element: el.id },
    );
  }
  return rawFile(ctx, view);
}

export async function pickRaws(
  ctx: BriefCtx,
  brief: Brief,
  use: Readonly<Record<string, number>>,
): Promise<ReadonlyMap<string, string>> {
  const placed = placedGenerated(brief);
  const unknown = Object.keys(use).filter((id) => !placed.some((e) => e.id === id));
  if (unknown.length > 0) {
    throw new StudioError(
      'USAGE',
      `--use names ${unknown.join(', ')}, which is not a generated element in the layout`,
      {
        elements: unknown,
      },
    );
  }
  const views = await attempts(ctx.workDir);
  const raws = new Map<string, string>();
  for (const el of placed) {
    const n = Object.hasOwn(use, el.id) ? use[el.id] : undefined;
    raws.set(
      el.id,
      n === undefined ? await currentRaw(ctx, brief, views, el) : await usedRaw(ctx, brief, views, el, n),
    );
  }
  return raws;
}

function fileOf(ctx: BriefCtx, raws: Raws, el: Element): string {
  if (el.method === 'draw') {
    throw new StudioError('UNEXPECTED', `${el.id} is drawn, it has no file`, { element: el.id });
  }
  if (el.method !== 'generate') return briefPath(ctx, el.file);
  const raw = raws.get(el.id);
  if (raw === undefined) {
    throw new StudioError('RAW_STALE', `${el.id} has no raw file to compose`, { element: el.id });
  }
  return raw;
}

// Each placed box with the path the brief checks report it under.
function placedBoxes(brief: Brief): { box: Box; path: string }[] {
  return brief.kind === 'image'
    ? brief.layout.map((box, j) => ({ box, path: `layout.${j}` }))
    : brief.cuts.flatMap((cut, i) => cut.layout.map((box, j) => ({ box, path: `cuts.${i}.layout.${j}` })));
}

// The brief allows a fitted still in one box only, so its box-sized redraw can stand in for the raw.
async function fitted(image: Image, rect: Rect, fit: Rect, at: { path: string; id: string }): Promise<Image> {
  const out = await fitStill(image, rect, fit);
  if (out.kind === 'fitted') return out.image;
  const reason = {
    'no-subject': `nothing printed on the paper of ${at.id} stands out to fit`,
    'no-paper': `the subject of ${at.id} leaves too little bare paper to extend`,
    'too-small': `the fit of ${at.id} shrinks its bare paper too small to extend; give the subject a larger fit`,
  }[out.kind];
  throw new StudioError('BRIEF_INVALID', reason, {
    issues: [{ path: `${at.path}.fit`, code: 'BRIEF_INVALID', reason }],
  });
}

// An SVG is rasterised at the box's own size, so one placed in boxes of several sizes is sharp in each.
async function svgStill(file: string, el: FileElement, [, , w, h]: Rect): Promise<Image> {
  const svg = await readSvg(file);
  const drawn = svg.kind === 'refused' ? svg : await drawSvg(svg, w, h, el.color);
  // The brief checks drew it, so the file changed since.
  if (drawn.kind === 'refused')
    throw new StudioError('BRIEF_INVALID', `${el.file} ${drawn.reason}`, { element: el.id });
  return drawn.image;
}

// Stills go through the canvas with the drawings, in the layout's z order.
async function loadStills(ctx: BriefCtx, brief: Brief, raws: Raws): Promise<Map<Box, Image>> {
  const byId = new Map(brief.elements.map((e) => [e.id, e] as const));
  const decoded = new Map<string, Image>();
  const stills = new Map<Box, Image>();
  for (const { box, path } of placedBoxes(brief)) {
    const el = byId.get(box.element);
    if (el === undefined || el.method === 'draw' || isVideoLayer(el)) continue;
    const file = fileOf(ctx, raws, el);
    if (el.method !== 'generate' && SVG_FILE.test(el.file)) {
      stills.set(box, await svgStill(file, el, box.rect));
      continue;
    }
    const image = decoded.get(el.id) ?? (await loadImage(await readFile(file)));
    decoded.set(el.id, image);
    stills.set(box, box.fit === undefined ? image : await fitted(image, box.rect, box.fit, { path, id: el.id }));
  }
  return stills;
}

type Layer = {
  file: string;
  rect: Box['rect'];
  enterMs: number;
  spanMs: number;
  audio: boolean;
  audioMs: number | null;
};

// A video layer brings its sound unless its element says keepAudio: false; a clip without a sound track is just silent.
async function layerOf(ctx: BriefCtx, raws: Raws, cut: Cut, box: Box, el: Element): Promise<Layer> {
  const file = fileOf(ctx, raws, el);
  const keep = isVideoLayer(el) && !('keepAudio' in el && el.keepAudio === false);
  const info = keep ? await probe(file) : null;
  return {
    file,
    rect: box.rect,
    enterMs: box.enterMs ?? 0,
    spanMs: visibleSpanMs(cut, box),
    audio: info?.hasAudio ?? false,
    audioMs: info?.audioDurationMs ?? null,
  };
}

async function layersOf(ctx: BriefCtx, brief: Brief, raws: Raws, cut: Cut): Promise<Layer[]> {
  const byId = new Map(brief.elements.map((e) => [e.id, e] as const));
  const layers: Layer[] = [];
  for (const box of cut.layout.toSorted((a, b) => a.z - b.z)) {
    const el = byId.get(box.element);
    if (el !== undefined && el.method !== 'draw' && isVideoLayer(el))
      layers.push(await layerOf(ctx, raws, cut, box, el));
  }
  return layers;
}

// getImageData is straight alpha, which the rgba input expects; the canvas's own buffer is premultiplied.
async function* overlayFrames(brief: VideoBrief, plan: CutPlan, images: ReadonlyMap<Box, Image>) {
  const { fps, width, height } = brief.frame;
  for (let n = plan.first; n < plan.last; n++) {
    const tMs = cutTimeMs(plan, n, fps);
    const canvas = renderFrame({ brief, cut: plan.cut, tMs, purpose: 'overlay', scale: 1, images, legend: false });
    const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);
    yield Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
}

const seconds = (ms: number): string => (ms / 1000).toFixed(3);

// The digital camera crops the finished cut, so it zooms the drawings along with the footage.
function cameraFilter(brief: VideoBrief, cut: Cut): string[] {
  const camera = cut.camera;
  if (camera === undefined || camera.mode !== 'digital') return [];
  const { width: w, height: h } = brief.frame;
  const p = `clip(t/${seconds(cut.durationMs)},0,1)`;
  const e = camera.ease === 'inOut' ? `(${p}*${p}*(3-2*${p}))` : p;
  const at = (i: number): string => {
    const [from, to] = [camera.from[i] ?? 0, camera.to[i] ?? 0];
    return `(${from}+(${to}-${from})*${e})`;
  };
  const zoom = `min(${w}/${at(2)},${h}/${at(3)})`;
  // The scaled size is spelled out because crop's in_w is the size the link had before the first frame.
  const pos = (i: 0 | 1, side: number): string =>
    `max(0,min(${side}*(${zoom}-1),(${at(i)}+${at(i + 2)}/2)*${zoom}-${side}/2))`;
  return [
    `scale=w='trunc(${w}*${zoom}/2)*2':h='trunc(${h}*${zoom}/2)*2':eval=frame`,
    `crop=${w}:${h}:x='${pos(0, w)}':y='${pos(1, h)}'`,
    'setsar=1',
  ];
}

// A layer whose picture ends before its span (an accepted clip may run short, and the container can outlast the
// picture once its sound is kept) holds its last frame to the span's end instead of uncovering the black ground.
function videoGraph(brief: VideoBrief, plan: CutPlan, layers: readonly Layer[], durSec: string): string {
  const { width, height, fps } = brief.frame;
  const parts = [`color=c=black:s=${width}x${height}:r=${fps}:d=${durSec}[b0]`];
  for (const [i, l] of layers.entries()) {
    const [x, y, w, h] = l.rect;
    const span = seconds(l.spanMs);
    const fit = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
    parts.push(
      `[${i + 1}:v]tpad=stop_mode=clone:stop_duration=${span},trim=duration=${span},setpts=PTS-STARTPTS,fps=${fps},${fit},setpts=PTS+${seconds(l.enterMs)}/TB[l${i}]`,
      `[b${i}][l${i}]overlay=${x}:${y}:eof_action=pass[b${i + 1}]`,
    );
  }
  const top = ['overlay=format=auto', ...cameraFilter(brief, plan.cut), 'format=yuv420p'];
  parts.push('[0:v]format=rgba[ov]', `[b${layers.length}][ov]${top.join(',')}[v]`);
  return parts.join(';');
}

async function renderCut(ctx: BriefCtx, brief: VideoBrief, a: CutPlanned): Promise<string> {
  const { plan, layers, images } = a;
  const { width, height, fps } = brief.frame;
  const durSec = ((plan.last - plan.first) / fps).toFixed(6);
  const args = ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0'];
  for (const l of layers) args.push('-i', l.file);
  args.push('-filter_complex', videoGraph(brief, plan, layers, durSec), '-map', '[v]');
  args.push('-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-crf', '16', '-r', String(fps));
  args.push('-t', durSec, '-f', 'mp4');
  const out = join(ctx.workDir, 'build', `cut-${fileSafe('cut', plan.cut.id)}.mp4`);
  const frames = Readable.from(overlayFrames(brief, plan, images));
  await atomically(out, (tmp) => runFfmpeg([...args, tmp], { stdin: frames }));
  return out;
}

type CutPlanned = { plan: CutPlan; layers: Layer[]; images: ReadonlyMap<Box, Image> };

// A kept clip sound on the film's timeline: the sample it starts at, the span it covers, and how long it fades past it.
type Sound = { file: string; atSample: number; spanMs: number; tailMs: number };

// The start counts from the cut's first frame, where the picture cuts. The tail is only as long as the clip has sound.
function soundsOf(plan: CutPlan, layers: readonly Layer[], fps: number): Sound[] {
  const cutAt = Math.round((plan.first * SAMPLE_RATE) / fps);
  return layers
    .filter((l) => l.audio)
    .map((l) => ({
      file: l.file,
      atSample: cutAt + Math.round((l.enterMs * SAMPLE_RATE) / 1000),
      spanMs: l.spanMs,
      tailMs: Math.max(0, Math.min(BRIDGE_MS, (l.audioMs ?? 0) - l.spanMs)),
    }));
}

// The concat demuxer reads each line as `file '<path>'`; a quote inside the path is closed, escaped and reopened.
function concatList(files: readonly string[]): string {
  return `${files.map((f) => `file '${f.replaceAll("'", "'\\''")}'`).join('\n')}\n`;
}

// One mix over the whole film from the clip files themselves: cut files encoded apart each add an encoder delay when
// joined, and a sound cut off at its span leaves the next clip's quiet start as a gap.
function clipsGraph(sounds: readonly Sound[], firstInput: number, totalMs: number): string {
  const fit = `aresample=${SAMPLE_RATE},aformat=channel_layouts=stereo`;
  const parts = [`anullsrc=r=${SAMPLE_RATE}:cl=stereo:d=${seconds(totalMs)}[s]`];
  for (const [i, s] of sounds.entries()) {
    const fade = s.tailMs > 0 ? `,afade=t=out:st=${seconds(s.spanMs)}:d=${seconds(s.tailMs)}` : '';
    const trim = `atrim=duration=${seconds(s.spanMs + s.tailMs)},asetpts=PTS-STARTPTS`;
    parts.push(`[${firstInput + i}:a]${trim},${fit}${fade},adelay=${s.atSample}S:all=1[k${i}]`);
  }
  const inputs = ['[s]', ...sounds.map((_, i) => `[k${i}]`)].join('');
  parts.push(`${inputs}amix=inputs=${sounds.length + 1}:duration=first:normalize=0[c]`);
  return parts.join(';');
}

// Music is cut or padded to the film, faded out over its last second, and mixed under any kept clip sound.
function mixGraph(brief: VideoBrief, totalMs: number, sounds: readonly Sound[]): string | null {
  const music = brief.audio;
  const fit = `aresample=${SAMPLE_RATE},aformat=channel_layouts=stereo`;
  const norm = `loudnorm=I=${TARGET_LUFS},aresample=${SAMPLE_RATE}`;
  const clips = sounds.length === 0 ? null : clipsGraph(sounds, music === undefined ? 1 : 2, totalMs);
  if (music === undefined) return clips === null ? null : `${clips};[c]${norm}[a]`;
  const fade = Math.min(MUSIC_FADE_MS, totalMs);
  const total = seconds(totalMs);
  const shaped = `volume=${music.gainDb}dB,${fit},apad=whole_dur=${total},atrim=duration=${total}`;
  const tail = `afade=t=out:st=${seconds(totalMs - fade)}:d=${seconds(fade)}`;
  if (clips === null) return `[1:a]${shaped},${tail},${norm}[a]`;
  return `${clips};[1:a]${shaped},${tail}[m];[c][m]amix=inputs=2:duration=first:normalize=0,${norm}[a]`;
}

async function joinCuts(ctx: BriefCtx, brief: VideoBrief, cutFiles: string[], sounds: Sound[], totalMs: number) {
  const list = scratchName(join(ctx.workDir, 'build', 'concat'), 'txt');
  const graph = mixGraph(brief, totalMs, sounds);
  const args = ['-f', 'concat', '-safe', '0', '-i', list];
  if (brief.audio) args.push('-i', briefPath(ctx, brief.audio.music));
  for (const s of sounds) args.push('-i', s.file);
  args.push('-map', '0:v:0', '-c:v', 'copy');
  if (graph !== null) args.push('-filter_complex', graph, '-map', '[a]', '-c:a', 'aac', '-b:a', '192k');
  args.push('-t', seconds(totalMs), '-movflags', '+faststart', '-f', 'mp4');
  const out = join(ctx.workDir, 'build', 'candidate.mp4');
  await writeFile(list, concatList(cutFiles));
  try {
    await atomically(out, (tmp) => runFfmpeg([...args, tmp]));
  } finally {
    await rm(list, { force: true });
  }
  return out;
}

async function composeVideo(ctx: BriefCtx, brief: VideoBrief, raws: Raws): Promise<string> {
  const { width, height } = brief.frame;
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new StudioError('BRIEF_INVALID', `frame ${width}x${height} must have even sides for yuv420p`, {
      frame: brief.frame,
    });
  }
  const images = await loadStills(ctx, brief, raws);
  const plans = planCuts(brief);
  const layered = await Promise.all(
    plans.map(async (plan) => ({ plan, layers: await layersOf(ctx, brief, raws, plan.cut) })),
  );
  const sounds = layered.flatMap(({ plan, layers }) => soundsOf(plan, layers, brief.frame.fps));
  const cutFiles: string[] = [];
  for (const { plan, layers } of layered) cutFiles.push(await renderCut(ctx, brief, { plan, layers, images }));
  const totalFrames = plans.reduce((sum, p) => sum + (p.last - p.first), 0);
  return joinCuts(ctx, brief, cutFiles, sounds, Math.round((totalFrames * 1000) / brief.frame.fps));
}

async function composeImage(ctx: BriefCtx, brief: Brief, raws: Raws): Promise<string> {
  const images = await loadStills(ctx, brief, raws);
  const canvas = renderFrame({ brief, cut: null, tMs: 0, purpose: 'overlay', scale: 1, images, legend: false });
  const out = join(ctx.workDir, 'build', 'candidate.png');
  const png = await canvas.encode('png');
  await atomically(out, (tmp) => writeFile(tmp, png, { flag: 'wx' }));
  return out;
}

export async function makeCandidate(
  ctx: BriefCtx,
  brief: Brief,
  raws: ReadonlyMap<string, string>,
): Promise<{ file: string; warnings: TextWarning[] }> {
  // Registers the fonts renderFrame relies on, and stops on a character the font cannot draw.
  const warnings = await textChecks({ codeRoot: ctx.repoRoot, home: ctx.home }, brief);
  await mkdir(join(ctx.workDir, 'build'), { recursive: true });
  const file = brief.kind === 'image' ? await composeImage(ctx, brief, raws) : await composeVideo(ctx, brief, raws);
  return { file, warnings };
}
