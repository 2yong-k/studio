import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { type Canvas, createCanvas } from '@napi-rs/canvas';
import { StudioError } from '../errors.ts';
import {
  type Box,
  type Brief,
  type BriefCtx,
  briefPath,
  type GenerateVideo,
  hasTimeline,
  keyframeOwner,
  visibleSpanMs,
} from '../works/index.ts';
import { type AudioPiece, mixPreviewAudio } from './animatic/audio.ts';
import { kit } from './animatic/kit.ts';
import { loadScene, type SceneModule } from './animatic/scene-module.ts';
import { drawStrip, planStrip, type Strip, type StripItem, stripHeightPx } from './animatic/strip.ts';
import { type ResolvedBeat, resolveBeats, sceneApi } from './animatic/timeline.ts';
import {
  type EngineName,
  type SpokenLine,
  speak,
  type Voice,
  type VoiceNotes,
  type VoiceSource,
} from './animatic/voice.ts';
import { type CutPlan, cutTimeMs, planCuts } from './cuts.ts';
import { PREVIEW_GROUND, renderFrame, type SceneDraw, textChecks } from './draw/scene.ts';
import type { TextWarning } from './draw/text.ts';
import { runFfmpeg } from './ffmpeg.ts';
import { atomically, fileSafe } from './files.ts';

export type PreviewDeps = { voice: Voice } | { source: VoiceSource };
export type PreviewWarning =
  | TextWarning
  | { element: string; kind: 'speech_overlap' | 'past_clip' | 'voice_estimated' };

// What the preview heard its lines with; `injected` is a bare voice a test or caller supplied.
type PreviewVoice = VoiceNotes & {
  engine: EngineName | 'none' | 'injected';
  readLines: number;
  estimatedLines: number;
};
export type PreviewOut = {
  video: string | null;
  frames: string[];
  layoutRefs: string[];
  warnings: PreviewWarning[];
  // Null when the preview spoke no line.
  voice: PreviewVoice | null;
};

type VideoBrief = Extract<Brief, { kind: 'video' }>;

// What a timeline adds to the video: scenes in their boxes, the strip above the frame and the mixed sound.
type Film = { scenes: ReadonlyMap<string, SceneDraw>; strip: Strip; sound: string };

const VIDEO_SCALE = 0.5;
const PART_FILL = 'rgba(255, 255, 255, 0.35)';
const PART_TEXT = '#ffffff';
const NO_IMAGES = new Map<Box, never>();
const NO_SCENES = new Map<string, SceneDraw>();

const writePng = (path: string, png: Buffer): Promise<void> =>
  atomically(path, (tmp) => writeFile(tmp, png, { flag: 'wx' }));

function frameCount(durationMs: number, fps: number): number {
  return Math.max(1, Math.round((durationMs * fps) / 1000));
}

const filmMs = (brief: VideoBrief): number => brief.cuts.reduce((sum, c) => sum + c.durationMs, 0);

const stripTopPx = (strip: Strip): number => Math.round(stripHeightPx(strip) * VIDEO_SCALE);

// The strip sits above the frame, so the frame keeps the place it has in the final film.
function underStrip(frame: Canvas, strip: Strip, filmTimeMs: number, widthPx: number): Canvas {
  const top = stripTopPx(strip);
  const canvas = createCanvas(frame.width, top + frame.height);
  const g = canvas.getContext('2d');
  g.scale(VIDEO_SCALE, VIDEO_SCALE);
  drawStrip(g, strip, filmTimeMs, widthPx);
  g.resetTransform();
  g.drawImage(frame, 0, top);
  return canvas;
}

async function* rawFrames(brief: VideoBrief, film?: Film): AsyncGenerator<Buffer> {
  const { fps } = brief.frame;
  for (const plan of planCuts(brief)) {
    for (let n = plan.first; n < plan.last; n++) {
      const tMs = cutTimeMs(plan, n, fps);
      const canvas = renderFrame({
        brief,
        cut: plan.cut,
        tMs,
        purpose: 'preview',
        scale: VIDEO_SCALE,
        images: NO_IMAGES,
        legend: true,
        scenes: film?.scenes ?? NO_SCENES,
      });
      yield (
        film === undefined ? canvas : underStrip(canvas, film.strip, plan.startMs + tMs, brief.frame.width)
      ).data();
    }
  }
}

function encodeArgs(ctx: BriefCtx, brief: VideoBrief, out: string, film?: Film): string[] {
  const { width, height, fps } = brief.frame;
  const w = Math.max(1, Math.round(width * VIDEO_SCALE));
  const h = Math.max(1, Math.round(height * VIDEO_SCALE)) + (film === undefined ? 0 : stripTopPx(film.strip));
  const total = (frameCount(filmMs(brief), fps) / fps).toFixed(3);
  const args = ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-r', String(fps), '-i', 'pipe:0'];
  if (film !== undefined) {
    // The mix already carries the music and runs the whole film.
    args.push('-i', film.sound, '-c:a', 'aac', '-map', '0:v:0', '-map', '1:a:0');
  } else if (brief.audio) {
    args.push('-i', briefPath(ctx, brief.audio.music), '-af', `volume=${brief.audio.gainDb}dB,apad`, '-c:a', 'aac');
    args.push('-map', '0:v:0', '-map', '1:a:0');
  }
  // yuv420p needs even sides; an odd half-size frame is rounded down by one pixel.
  args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast');
  args.push('-crf', '30', '-t', total, '-f', 'mp4', out);
  return args;
}

async function renderVideo(ctx: BriefCtx, brief: VideoBrief, path: string, film?: Film): Promise<void> {
  await atomically(path, (tmp) =>
    runFfmpeg(encodeArgs(ctx, brief, tmp, film), { stdin: Readable.from(rawFrames(brief, film)) }),
  );
}

async function renderCutFrames(
  brief: VideoBrief,
  dir: string,
  scenes: ReadonlyMap<string, SceneDraw> = NO_SCENES,
): Promise<string[]> {
  const paths: string[] = [];
  for (const cut of brief.cuts) {
    const path = join(dir, `${fileSafe('cut', cut.id)}.png`);
    const canvas = renderFrame({
      brief,
      cut,
      tMs: 0,
      purpose: 'preview',
      scale: 1,
      images: NO_IMAGES,
      legend: false,
      scenes,
    });
    await writePng(path, await canvas.encode('png'));
    paths.push(path);
  }
  return paths;
}

// A timeline element where it plays in the film. Line and beat times are clip times; startMs is the film time of the
// clip's first frame (cut start + enterMs), and the box shows the clip for spanMs.
type Track = {
  el: GenerateVideo;
  startMs: number;
  spanMs: number;
  lines: SpokenLine[];
  beats: ResolvedBeat[];
  scene: SceneDraw | undefined;
};

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function placeBeats(el: GenerateVideo, lines: readonly SpokenLine[]): ResolvedBeat[] {
  try {
    return resolveBeats(el.beats ?? [], lines);
  } catch (e) {
    throw new StudioError('SCENE_FAILED', `the beats of ${el.id} cannot be placed: ${reasonOf(e)}`, { element: el.id });
  }
}

// The scene and the S it calls throw plain errors; the element and clip time say which scene to fix and where.
function sceneDraw(
  el: GenerateVideo,
  box: Box,
  lines: readonly SpokenLine[],
  beats: readonly ResolvedBeat[],
  scene: SceneModule,
): SceneDraw {
  const S = sceneApi({ el, box, lines, beats });
  return (g, clipMs) => {
    try {
      scene.draw(g, clipMs, S, kit);
    } catch (e) {
      const why = `the scene of ${el.id} failed at ${Math.round(clipMs)} ms: ${reasonOf(e)}`;
      throw new StudioError('SCENE_FAILED', why, { element: el.id, clipMs });
    }
  };
}

async function trackOf(
  ctx: BriefCtx,
  plan: CutPlan,
  box: Box,
  el: GenerateVideo,
  voiceDir: string,
  voice: Voice,
  readWords: boolean,
): Promise<Track> {
  // Each element speaks into its own folder, since speak names its files by line number.
  await mkdir(voiceDir);
  const lines = el.speech === undefined ? [] : await speak(el.speech, voiceDir, voice, readWords);
  const beats = placeBeats(el, lines);
  const scene =
    el.scene === undefined ? undefined : sceneDraw(el, box, lines, beats, await loadScene(join(ctx.workDir, el.scene)));
  const startMs = plan.startMs + (box.enterMs ?? 0);
  return { el, startMs, spanMs: visibleSpanMs(plan.cut, box), lines, beats, scene };
}

// A generated video is placed once (loadBrief refuses more), so its first box is the one that plays it.
async function tracksOf(
  ctx: BriefCtx,
  brief: VideoBrief,
  voiceRoot: string,
  voice: Voice,
  readWords: boolean,
): Promise<Track[]> {
  const byId = new Map(brief.elements.map((e) => [e.id, e] as const));
  const tracks: Track[] = [];
  for (const plan of planCuts(brief)) {
    for (const box of plan.cut.layout) {
      const el = byId.get(box.element);
      if (el?.method !== 'generate' || el.output !== 'video' || !hasTimeline(el)) continue;
      if (tracks.some((t) => t.el.id === el.id)) continue;
      tracks.push(await trackOf(ctx, plan, box, el, join(voiceRoot, String(tracks.length)), voice, readWords));
    }
  }
  return tracks;
}

function trackWarnings(t: Track): PreviewWarning[] {
  const warnings: PreviewWarning[] = [];
  const byAt = t.lines.toSorted((a, b) => a.atMs - b.atMs);
  if (byAt.some((l, i) => i > 0 && (byAt[i - 1]?.endMs ?? l.startMs) > l.startMs)) {
    warnings.push({ element: t.el.id, kind: 'speech_overlap' });
  }
  const endMs = Math.min(t.el.durationMs, t.spanMs);
  if ([...t.lines, ...t.beats].some((x) => x.endMs > endMs)) warnings.push({ element: t.el.id, kind: 'past_clip' });
  if (t.lines.some((l) => l.file === null)) warnings.push({ element: t.el.id, kind: 'voice_estimated' });
  return warnings;
}

const stripItems = (t: Track): StripItem[] => [
  ...t.lines.map(
    (l): StripItem => ({ kind: 'line', label: l.text, startMs: t.startMs + l.startMs, endMs: t.startMs + l.endMs }),
  ),
  ...t.beats.map(
    (b): StripItem => ({ kind: 'beat', label: b.label, startMs: t.startMs + b.startMs, endMs: t.startMs + b.endMs }),
  ),
];

// The film drops a clip's sound when it says keepAudio: false, so its voice and room tone stay out too; like the
// composite, sound stops when the box leaves.
function soundPieces(t: Track): AudioPiece[] {
  if (t.el.keepAudio === false) return [];
  const untilMs = t.startMs + t.spanMs;
  // An estimated line has no sound; the room tone still plays.
  const voices = t.lines.flatMap((l): AudioPiece[] =>
    l.file === null ? [] : [{ kind: 'voice', file: l.file, atMs: t.startMs + l.atMs, untilMs }],
  );
  const hasRoom = t.el.scene !== undefined || t.el.speech !== undefined;
  return hasRoom ? [{ kind: 'room', atMs: t.startMs, untilMs }, ...voices] : voices;
}

// Voice files live only in an OS temp folder: the work folder gets them only inside preview.mp4.
async function renderTimeline(
  ctx: BriefCtx,
  brief: VideoBrief,
  dir: string,
  video: string,
  voice: Voice,
  readWords: boolean,
): Promise<{ frames: string[]; warnings: PreviewWarning[]; readLines: number; estimatedLines: number }> {
  const work = await mkdtemp(join(tmpdir(), 'studio-preview-voice-'));
  try {
    const tracks = await tracksOf(ctx, brief, work, voice, readWords);
    const scenes = new Map(tracks.flatMap((t) => (t.scene === undefined ? [] : [[t.el.id, t.scene] as const])));
    const frames = await renderCutFrames(brief, dir, scenes);
    const totalMs = filmMs(brief);
    const strip = planStrip(
      totalMs,
      planCuts(brief).map((p) => p.startMs),
      tracks.flatMap(stripItems),
    );
    const sound = join(work, 'sound.wav');
    const music =
      brief.audio === undefined ? null : { file: briefPath(ctx, brief.audio.music), gainDb: brief.audio.gainDb };
    await mixPreviewAudio(tracks.flatMap(soundPieces), music, totalMs, sound);
    await renderVideo(ctx, brief, video, { scenes, strip, sound });
    const lines = tracks.flatMap((t) => t.lines);
    const estimatedLines = lines.filter((l) => l.file === null).length;
    return {
      frames,
      warnings: tracks.flatMap(trackWarnings),
      readLines: lines.length - estimatedLines,
      estimatedLines,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// A keyframe has no box of its own: the layout guide is the box of the video that starts from it.
function boxOf(brief: Brief, id: string): Box {
  const layouts: readonly (readonly Box[])[] =
    brief.kind === 'image' ? [brief.layout] : brief.cuts.map((c) => c.layout);
  for (const layout of layouts) {
    const box = layout.find((b) => b.element === id);
    if (box !== undefined) return box;
  }
  return keyframeOwner(brief, id).box;
}

// Only the parts are drawn: the guide says where things go, not what the box is for. The bytes depend on the brief
// alone, so generate can tell a guide drawn from an earlier brief by drawing it again.
export async function renderLayoutRef(brief: Brief, id: string): Promise<Buffer> {
  const box = boxOf(brief, id);
  const [bx, by, w, h] = box.rect;
  const canvas = createCanvas(w, h);
  const c = canvas.getContext('2d');
  c.fillStyle = PREVIEW_GROUND;
  c.fillRect(0, 0, w, h);
  c.translate(-bx, -by);
  const size = Math.max(12, Math.round(Math.min(w, h) * 0.05));
  c.font = `${size}px "pretendard-bold"`;
  c.textBaseline = 'top';
  for (const part of box.parts ?? []) {
    const [x, y, pw, ph] = part.rect;
    c.fillStyle = PART_FILL;
    c.fillRect(x, y, pw, ph);
    c.fillStyle = PART_TEXT;
    c.fillText(part.label, x + size / 2, y + size / 2, Math.max(1, pw - size));
  }
  return canvas.encode('png');
}

async function renderLayoutRefs(brief: Brief, dir: string): Promise<string[]> {
  const paths: string[] = [];
  for (const el of brief.elements) {
    if (el.method !== 'generate' || el.output !== 'image' || el.layoutRef !== true) continue;
    const path = join(dir, `ref-${fileSafe('element', el.id)}.png`);
    await writePng(path, await renderLayoutRef(brief, el.id));
    paths.push(path);
  }
  return paths;
}

// Either deps as one shape: a VoiceSource whose report may also name `injected`.
type PreviewSource = Omit<VoiceSource, 'report'> & { report(): VoiceNotes & Pick<PreviewVoice, 'engine'> };

// An injected voice reads every word and reports itself as `injected`.
function voiceOf(deps: PreviewDeps): PreviewSource {
  if ('source' in deps) return deps.source;
  return {
    voice: deps.voice,
    readWords: true,
    report: () => ({ engine: 'injected', missing: [], degraded: [] }),
  };
}

export async function renderPreview(ctx: BriefCtx, brief: Brief, deps: PreviewDeps): Promise<PreviewOut> {
  // Registers the fonts renderFrame relies on, and stops on a character the font cannot draw.
  const warnings = await textChecks({ codeRoot: ctx.repoRoot, home: ctx.home }, brief);
  const dir = join(ctx.workDir, 'preview');
  await mkdir(dir, { recursive: true });
  if (brief.kind === 'image') {
    const framePath = join(dir, 'frame.png');
    const canvas = renderFrame({
      brief,
      cut: null,
      tMs: 0,
      purpose: 'preview',
      scale: 1,
      images: NO_IMAGES,
      legend: false,
    });
    await writePng(framePath, await canvas.encode('png'));
    return { video: null, frames: [framePath], layoutRefs: await renderLayoutRefs(brief, dir), warnings, voice: null };
  }
  const video = join(dir, 'preview.mp4');
  if (brief.elements.some(hasTimeline)) {
    const { voice: speakWith, readWords, report } = voiceOf(deps);
    const film = await renderTimeline(ctx, brief, dir, video, speakWith, readWords);
    const layoutRefs = await renderLayoutRefs(brief, dir);
    const { readLines, estimatedLines } = film;
    const notes = report();
    const voice = readLines + estimatedLines === 0 ? null : { ...notes, readLines, estimatedLines };
    return { video, frames: film.frames, layoutRefs, warnings: [...warnings, ...film.warnings], voice };
  }
  const frames = await renderCutFrames(brief, dir);
  await renderVideo(ctx, brief, video);
  return { video, frames, layoutRefs: await renderLayoutRefs(brief, dir), warnings, voice: null };
}
