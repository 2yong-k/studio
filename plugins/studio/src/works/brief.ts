import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { StudioError } from '../errors.ts';
import { licenseOf } from './assets.ts';
import { isLink, readJsonHashed, resolveInside, sha256File } from './files.ts';
import { isAllowed, type ModelEntry, type Rect, resolveSize } from './models.ts';
import { nameIssue } from './names.ts';
import { type PictureFormat, pictureFormat, sameRatio, storedSize } from './picture.ts';
import { attempts } from './spend.ts';
import { drawSvg, readSvg, SVG_FILE, type Svg } from './svg.ts';

const BRIEF_FILE = 'brief.json';

const Id = z.string().min(1);
const Text = z.string().min(1);
const PosInt = z.int().positive();
const Ms = z.int().nonnegative();
const RectSchema = z.tuple([z.int(), z.int(), PosInt, PosInt]);
const SizeOverride = z.tuple([PosInt, PosInt]);
const Font = z.union([
  z.enum(['pretendard-regular', 'pretendard-bold', 'inter-regular', 'instrument-serif-regular']),
  z.string().startsWith('assets/fonts/'),
]);

const identity = { id: Id, label: Text };

const GenerateImageSchema = z.strictObject({
  ...identity,
  method: z.literal('generate'),
  output: z.literal('image'),
  model: Id,
  prompt: Text,
  refs: z.array(Text).optional(),
  layoutRef: z.boolean().optional(),
  size: SizeOverride.optional(),
});

const VoiceKindSchema = z.enum(['male', 'female']);

const SpeechSchema = z.strictObject({
  voice: VoiceKindSchema,
  lines: z.array(z.strictObject({ text: Text, atMs: Ms })).min(1),
});

const BeatSchema = z
  .strictObject({
    id: Id,
    label: Text,
    at: z.union([
      z.strictObject({ word: Text }),
      z.strictObject({ lineEnd: z.int().nonnegative() }),
      z.strictObject({ ms: Ms }),
    ]),
    offsetMs: z.int().optional(),
    durationMs: PosInt.optional(),
    prompt: Text.optional(),
    previewOnly: z.literal(true).optional(),
  })
  .refine((b) => (b.prompt === undefined) !== (b.previewOnly === undefined), {
    message: 'give exactly one of prompt and previewOnly',
  });

const GenerateVideoSchema = z
  .strictObject({
    ...identity,
    method: z.literal('generate'),
    output: z.literal('video'),
    model: Id,
    prompt: Text,
    from: Id.optional(),
    fromFile: Text.optional(),
    toFile: Text.optional(),
    durationMs: PosInt,
    keepAudio: z.boolean().optional(),
    size: SizeOverride.optional(),
    scene: Text.optional(),
    speech: SpeechSchema.optional(),
    beats: z.array(BeatSchema).optional(),
  })
  .refine((v) => (v.from === undefined) !== (v.fromFile === undefined), {
    message: 'give exactly one of from and fromFile',
  });

const DrawSchema = z
  .strictObject({
    ...identity,
    method: z.literal('draw'),
    color: Text,
    text: Text.optional(),
    shape: z.enum(['rect', 'roundRect', 'line', 'arrow', 'circle']).optional(),
    font: Font.optional(),
    sizePx: PosInt.optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    valign: z.enum(['top', 'middle']).optional(),
    letterSpacingPx: z.int().optional(),
    lineHeightPx: PosInt.optional(),
    // One phrase of the text drawn over a band (the brand Mark); see src/make/draw/text.ts.
    mark: z.strictObject({ text: Text, color: Text, textColor: Text }).optional(),
  })
  .refine((d) => (d.text === undefined) !== (d.shape === undefined), {
    message: 'give exactly one of text and shape',
  });

const FileElementSchema = z.strictObject({
  ...identity,
  method: z.enum(['capture', 'composite']),
  file: Text,
  keepAudio: z.boolean().optional(),
  // What currentColor becomes in an SVG file.
  color: Text.optional(),
});

const ElementSchema = z.discriminatedUnion('method', [
  z.discriminatedUnion('output', [GenerateImageSchema, GenerateVideoSchema]),
  DrawSchema,
  FileElementSchema,
]);

const BoxSchema = z.strictObject({
  element: Id,
  rect: RectSchema,
  z: z.int(),
  parts: z.array(z.strictObject({ label: Text, rect: RectSchema })).optional(),
  // Where make sets the still's subject, in frame pixels; see src/make/draw/fit.ts.
  fit: RectSchema.optional(),
  enterMs: Ms.optional(),
  exitMs: Ms.optional(),
  anim: z.enum(['fade', 'slide']).optional(),
});

const CutSchema = z.strictObject({
  id: Id,
  durationMs: PosInt,
  camera: z
    .strictObject({
      mode: z.enum(['prompt', 'digital']),
      from: RectSchema,
      to: RectSchema,
      ease: z.enum(['linear', 'inOut']),
    })
    .optional(),
  layout: z.array(BoxSchema),
});

const common = {
  schema: z.literal(1),
  work: Text,
  intent: Text,
  mood: Text,
  assets: z.array(Text).optional(),
  elements: z.array(ElementSchema),
  audio: z.strictObject({ music: Text, gainDb: z.number() }).optional(),
};

const briefSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...common,
    kind: z.literal('image'),
    frame: z.strictObject({ width: PosInt, height: PosInt }),
    layout: z.array(BoxSchema),
  }),
  z.strictObject({
    ...common,
    kind: z.literal('video'),
    frame: z.strictObject({ width: PosInt, height: PosInt, fps: PosInt }),
    cuts: z.array(CutSchema).min(1),
  }),
]);

export type Brief = z.infer<typeof briefSchema>;
export type Element = z.infer<typeof ElementSchema>;
export type GenerateImage = z.infer<typeof GenerateImageSchema>;
export type GenerateVideo = z.infer<typeof GenerateVideoSchema>;
export type VoiceKind = z.infer<typeof VoiceKindSchema>;
export type Speech = z.infer<typeof SpeechSchema>;
export type Beat = z.infer<typeof BeatSchema>;
export type Draw = z.infer<typeof DrawSchema>;
export type FileElement = z.infer<typeof FileElementSchema>;
export type Method = Element['method'];
export type Box = z.infer<typeof BoxSchema>;
export type Cut = z.infer<typeof CutSchema>;
type IssueCode = 'BRIEF_INVALID' | 'MODEL_NOT_ALLOWED' | 'ASSET_LICENSE_MISSING';
export type BriefIssue = { path: string; code: IssueCode; reason: string };
export type BriefCtx = { workDir: string; repoRoot: string; home: string; models: ReadonlyMap<string, ModelEntry> };

const isGenerate = (e: Element): e is GenerateImage | GenerateVideo => e.method === 'generate';
const isVideoGen = (e: Element): e is GenerateVideo => e.method === 'generate' && e.output === 'video';
const isImageGen = (e: Element): e is GenerateImage => e.method === 'generate' && e.output === 'image';

export const hasTimeline = (e: Element): boolean =>
  isVideoGen(e) && (e.scene !== undefined || e.speech !== undefined || e.beats !== undefined);

type Token = { raw: string; bare: string };

// A word that is only punctuation stays in the list, so positions here match the voice side word for word.
export function tokens(text: string): Token[] {
  return text
    .split(/\s+/u)
    .filter((raw) => raw !== '')
    .map((raw) => ({ raw, bare: raw.replace(/\p{P}/gu, '') }));
}

export function wordAt(lines: readonly { text: string }[], word: string): { line: number; index: number } | null {
  for (const [line, l] of lines.entries()) {
    const index = tokens(l.text).findIndex((t) => t.bare.includes(word));
    if (index >= 0) return { line, index };
  }
  return null;
}

const VIDEO_FILE = /\.(mp4|mov|m4v|webm)$/i;

// A generated clip or a screen recording sits under the drawn and still layers so the canvas frame can go over it.
export function isVideoLayer(e: Element): boolean {
  if (isGenerate(e)) return e.output === 'video';
  return e.method === 'draw' ? false : VIDEO_FILE.test(e.file);
}

const bad = (path: string, reason: string, code: IssueCode = 'BRIEF_INVALID'): BriefIssue => ({ path, code, reason });

export function visibleSpanMs(cut: Cut, box: Box): number {
  return (box.exitMs ?? cut.durationMs) - (box.enterMs ?? 0);
}

function boxesOf(brief: Brief): { path: string; cut: Cut | null; boxes: readonly Box[] }[] {
  if (brief.kind === 'image') return [{ path: 'layout', cut: null, boxes: brief.layout }];
  return brief.cuts.map((cut, i) => ({ path: `cuts.${i}.layout`, cut, boxes: cut.layout }));
}

export function keyframeOwner(brief: Brief, keyframeId: string): { video: GenerateVideo; cut: Cut; box: Box } {
  if (brief.kind === 'video') {
    for (const cut of brief.cuts) {
      for (const box of cut.layout) {
        const video = brief.elements.filter(isVideoGen).find((e) => e.id === box.element && e.from === keyframeId);
        if (video !== undefined) return { video, cut, box };
      }
    }
  }
  throw new StudioError('NOT_FOUND', `no video uses ${keyframeId} as its keyframe`, { keyframe: keyframeId });
}

type Placement = { path: string; cut: Cut | null; box: Box };

type Scan = {
  brief: Brief;
  ctx: BriefCtx;
  byId: ReadonlyMap<string, Element>;
  placements: ReadonlyMap<string, Placement[]>;
  // keyframe id -> the video elements that name it in `from`, in document order
  users: ReadonlyMap<string, GenerateVideo[]>;
  // The element ids the work's spend lines name. They keep 0.1's id rules, so a paid work in progress never stops after
  // an update and its records keep their names; every other id meets the portable rules.
  spent: ReadonlySet<string>;
};

function scan(brief: Brief, ctx: BriefCtx, spent: ReadonlySet<string>): Scan {
  const byId = new Map<string, Element>();
  const users = new Map<string, GenerateVideo[]>();
  for (const e of brief.elements) {
    if (!byId.has(e.id)) byId.set(e.id, e);
    if (isVideoGen(e) && e.from !== undefined) users.set(e.from, [...(users.get(e.from) ?? []), e]);
  }
  const placements = new Map<string, Placement[]>();
  for (const l of boxesOf(brief)) {
    for (const [j, box] of l.boxes.entries()) {
      const at: Placement = { path: `${l.path}.${j}`, cut: l.cut, box };
      placements.set(box.element, [...(placements.get(box.element) ?? []), at]);
    }
  }
  return { brief, ctx, byId, placements, users, spent };
}

function checkWork(s: Scan): BriefIssue[] {
  const folder = basename(s.ctx.workDir);
  return s.brief.work === folder ? [] : [bad('work', `work "${s.brief.work}" must equal the folder name "${folder}"`)];
}

type Seen = { id: string; i: number };

// An exact repeat is reported on the later id. Ids that differ only in case or Unicode form clash unless both are kept;
// the issue goes on the one that is not, so renaming it leaves the paid records' names alone.
function clashes(id: string, i: number, other: Seen, kept: ReadonlySet<string>): boolean {
  if (other.id === id) return other.i < i;
  return !kept.has(id) && (other.i < i || kept.has(other.id));
}

function duplicates(
  ids: readonly string[],
  path: (i: number) => string,
  what: string,
  fold: (id: string) => string = (id) => id,
  kept: ReadonlySet<string> = new Set(),
): BriefIssue[] {
  const groups = new Map<string, Seen[]>();
  for (const [i, id] of ids.entries()) groups.set(fold(id), [...(groups.get(fold(id)) ?? []), { id, i }]);
  return ids.flatMap((id, i) => {
    const clash = groups.get(fold(id))?.find((other) => clashes(id, i, other, kept));
    if (clash === undefined) return [];
    // A clash in case or Unicode form alone names the other id, since the two do not read alike on the page.
    const also = clash.id === id ? '' : ` (same file name as ${clash.id})`;
    return [bad(path(i), `duplicate ${what} id ${id}${also}`)];
  });
}

// Element and cut ids become file names, and macOS and Windows disks ignore case (macOS the Unicode form too), so
// `Logo` and `logo` name one file. Upper case first: Windows upcases a dotless i and a long s to I and S, and macOS
// folds a long s to s, while toLowerCase alone leaves both. Only a comparison key, never a path.
const asFileName = (id: string): string => id.normalize('NFC').toUpperCase().toLowerCase();

// A kept id keeps 0.1's rules: only an exact repeat is refused.
function idIssues(
  ids: readonly string[],
  path: (i: number) => string,
  what: string,
  kept: ReadonlySet<string>,
): BriefIssue[] {
  const named = ids.flatMap((id, i) => {
    const issue = kept.has(id) ? null : nameIssue(id);
    return issue === null ? [] : [bad(path(i), `id "${id}" ${issue}`)];
  });
  return [...named, ...duplicates(ids, path, what, asFileName, kept)];
}

// A spent id dropped from the brief still names its paid files in raw/, which a new id that folds onto it would
// replace on a disk that ignores case. A clash with a spent id still in the brief is left to `duplicates`.
function droppedSpentClashes(ids: readonly string[], spent: ReadonlySet<string>): BriefIssue[] {
  const inBrief = new Set(ids);
  const dropped = new Map<string, string>();
  for (const id of spent) {
    if (!inBrief.has(id) && !dropped.has(asFileName(id))) dropped.set(asFileName(id), id);
  }
  return ids.flatMap((id, i) => {
    const owner = spent.has(id) ? undefined : dropped.get(asFileName(id));
    return owner === undefined
      ? []
      : [bad(`elements.${i}.id`, `element id ${id} has the same file name as ${owner}, which has spent`)];
  });
}

function checkIds(s: Scan): BriefIssue[] {
  const elementIds = s.brief.elements.map((e) => e.id);
  const issues = [
    ...idIssues(elementIds, (i) => `elements.${i}.id`, 'element', s.spent),
    ...droppedSpentClashes(elementIds, s.spent),
  ];
  if (s.brief.kind === 'video') {
    const cutIds = s.brief.cuts.map((c) => c.id);
    // Cut ids cost no money, so a work that has spent keeps 0.1's rules for all of them.
    issues.push(...idIssues(cutIds, (i) => `cuts.${i}.id`, 'cut', new Set(s.spent.size === 0 ? [] : cutIds)));
  }
  return issues;
}

const inside = ([x, y, w, h]: Rect, [bx, by, bw, bh]: Rect): boolean =>
  x >= bx && y >= by && x + w <= bx + bw && y + h <= by + bh;

// make fits a still into its box once, so the box must hold a still of its own and enclose the fit.
function checkFit(s: Scan, path: string, box: Box, target: Element | undefined): BriefIssue[] {
  if (box.fit === undefined) return [];
  const at = `${path}.fit`;
  if (!inside(box.fit, box.rect))
    return [bad(at, `fit ${box.fit.join(',')} must lie inside rect ${box.rect.join(',')}`)];
  if (target === undefined) return [];
  if (target.method === 'draw' || isVideoLayer(target)) return [bad(at, `${target.id} is not a still image to fit`)];
  if (!isGenerate(target) && SVG_FILE.test(target.file)) {
    return [bad(at, `${target.id} is an SVG drawn at its box size; it cannot be fitted`)];
  }
  if ((s.placements.get(target.id)?.length ?? 0) > 1) {
    return [bad(at, `${target.id} is fitted, so it can be placed in one box only`)];
  }
  return [];
}

function checkBox(s: Scan, path: string, cut: Cut | null, box: Box): BriefIssue[] {
  const issues: BriefIssue[] = [];
  const target = s.byId.get(box.element);
  if (target === undefined) issues.push(bad(`${path}.element`, `no element has id ${box.element}`));
  else if (isImageGen(target) && s.users.has(target.id)) {
    issues.push(bad(`${path}.element`, `${target.id} is a keyframe and cannot be placed in a layout`));
  }
  issues.push(...checkFit(s, path, box, target));
  if (cut === null) return issues;
  if (box.exitMs !== undefined && box.exitMs > cut.durationMs) {
    issues.push(bad(`${path}.exitMs`, `exitMs ${box.exitMs} is past the cut end ${cut.durationMs}`));
  }
  const end = box.exitMs ?? cut.durationMs;
  if ((box.enterMs ?? 0) >= end)
    issues.push(bad(`${path}.enterMs`, `enterMs ${box.enterMs ?? 0} must be before ${end}`));
  return issues;
}

function checkBoxes(s: Scan): BriefIssue[] {
  return boxesOf(s.brief).flatMap((l) => l.boxes.flatMap((box, j) => checkBox(s, `${l.path}.${j}`, l.cut, box)));
}

// Video layers must sit strictly below every other layer; the video box is the one reported.
function checkZOrder(s: Scan): BriefIssue[] {
  const issues: BriefIssue[] = [];
  for (const l of boxesOf(s.brief)) {
    const known = l.boxes.flatMap((box, j) => {
      const el = s.byId.get(box.element);
      return el === undefined ? [] : [{ box, j, video: isVideoLayer(el) }];
    });
    const others = known.filter((k) => !k.video).map((k) => k.box.z);
    if (others.length === 0) continue;
    const lowestOther = Math.min(...others);
    for (const k of known) {
      if (k.video && k.box.z >= lowestOther) {
        issues.push(
          bad(`${l.path}.${k.j}.z`, `video layer z ${k.box.z} must be below other layers (lowest is ${lowestOther})`),
        );
      }
    }
  }
  return issues;
}

function modelOf(
  s: Scan,
  e: GenerateImage | GenerateVideo,
  i: number,
): { model: ModelEntry | null; issues: BriefIssue[] } {
  const path = `elements.${i}.model`;
  const model = s.ctx.models.get(e.model);
  if (model === undefined) return { model: null, issues: [bad(path, `unknown model ${e.model}`)] };
  if (model.output !== e.output) {
    return { model: null, issues: [bad(path, `model ${e.model} makes ${model.output}, element wants ${e.output}`)] };
  }
  if (!isAllowed(model)) {
    return { model: null, issues: [bad(path, `model ${e.model} has no commercial-use record`, 'MODEL_NOT_ALLOWED')] };
  }
  return { model, issues: [] };
}

function checkPlacement(s: Scan, e: GenerateImage | GenerateVideo, i: number): BriefIssue[] {
  const at = s.placements.get(e.id) ?? [];
  const issues = at.slice(1).map((p) => bad(`${p.path}.element`, `${e.id} may be placed only once`));
  const keyframe = isImageGen(e) && s.users.has(e.id);
  if (at.length === 0 && !keyframe) {
    issues.push(bad(`elements.${i}.id`, `${e.id} is in no layout, so it must be the keyframe of a video`));
  }
  return issues;
}

// The rect a generated element is sized from: its own box, or its video's box for a keyframe.
function sizingRect(s: Scan, e: GenerateImage | GenerateVideo): Box['rect'] | null {
  const owner = isImageGen(e) ? s.users.get(e.id)?.[0] : undefined;
  const source = owner ?? e;
  return s.placements.get(source.id)?.[0]?.box.rect ?? null;
}

function checkSize(s: Scan, e: GenerateImage | GenerateVideo, i: number, model: ModelEntry): BriefIssue[] {
  const rect = sizingRect(s, e);
  if (rect === null || resolveSize(model, rect, e.size) !== null) return [];
  return [bad(`elements.${i}.size`, `model ${e.model} has no size for ${rect[2]}x${rect[3]}`)];
}

function checkRefs(e: GenerateImage, i: number, model: ModelEntry): BriefIssue[] {
  const count = (e.refs?.length ?? 0) + (e.layoutRef ? 1 : 0);
  const slot = model.slots.refs;
  const path = e.refs?.length ? `elements.${i}.refs` : `elements.${i}.layoutRef`;
  if (slot === null) return count === 0 ? [] : [bad(path, `model ${e.model} takes no reference images`)];
  if (count >= slot.min && count <= slot.max) return [];
  return [bad(path, `${count} reference images; model ${e.model} takes ${slot.min} to ${slot.max}`)];
}

// A given picture is one the user already chose. raw/ and build/ hold generated results they may not have seen, and opening
// a video on one of those would skip the keyframe review.
const GIVEN_DIRS = ['assets/', 'inputs/'];
const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;

const inGivenDir = (rel: string): boolean => GIVEN_DIRS.some((dir) => rel.startsWith(dir));
const givenDirReason = (rel: string): string => `${rel} must be under assets/ or inputs/`;

function checkGivenFile(rel: string, path: string): BriefIssue[] {
  if (!inGivenDir(rel)) return [bad(path, givenDirReason(rel))];
  return IMAGE_FILE.test(rel) ? [] : [bad(path, `${rel} must be a png, jpeg or webp image`)];
}

function checkKeyframeSource(s: Scan, e: GenerateVideo, i: number): BriefIssue[] {
  if (e.fromFile !== undefined) return checkGivenFile(e.fromFile, `elements.${i}.fromFile`);
  // The schema already refused a video with neither.
  if (e.from === undefined) return [];
  const path = `elements.${i}.from`;
  const target = s.byId.get(e.from);
  if (target === undefined || !isImageGen(target)) return [bad(path, `from ${e.from} must be a generated image`)];
  if (s.users.get(e.from)?.[0] !== e) return [bad(path, `keyframe ${e.from} is already used by another video`)];
  return [];
}

function checkDuration(s: Scan, e: GenerateVideo, i: number, model: ModelEntry): BriefIssue[] {
  const path = `elements.${i}.durationMs`;
  const issues: BriefIssue[] = [];
  if (!model.durations.some((d) => d.ms === e.durationMs)) {
    issues.push(bad(path, `model ${e.model} cannot make ${e.durationMs} ms`));
  }
  const at = s.placements.get(e.id)?.[0];
  if (at?.cut) {
    const span = visibleSpanMs(at.cut, at.box);
    if (e.durationMs < span) issues.push(bad(path, `${e.durationMs} ms is shorter than the visible ${span} ms`));
  }
  return issues;
}

// The path is checked whatever the model, like the first frame's; only the slot needs the model.
function checkLastFrameFile(e: GenerateVideo, i: number): BriefIssue[] {
  return e.toFile === undefined ? [] : checkGivenFile(e.toFile, `elements.${i}.toFile`);
}

function checkLastFrame(e: GenerateVideo, i: number, model: ModelEntry): BriefIssue[] {
  if (e.toFile === undefined || model.slots.lastFrame !== null) return [];
  return [bad(`elements.${i}.toFile`, `model ${e.model} has no last-frame slot`)];
}

function checkVideo(s: Scan, e: GenerateVideo, i: number, model: ModelEntry): BriefIssue[] {
  const issues = [...checkDuration(s, e, i, model), ...checkLastFrame(e, i, model)];
  if (model.slots.firstFrame === null)
    issues.push(bad(`elements.${i}.model`, `model ${e.model} has no first-frame slot`));
  return issues;
}

function checkSpeech(e: GenerateVideo, i: number): BriefIssue[] {
  if (e.speech === undefined) return [];
  const { lines } = e.speech;
  const issues = lines.flatMap((l, k) =>
    e.prompt.includes(l.text)
      ? []
      : [bad(`elements.${i}.speech.lines.${k}.text`, `the prompt does not contain "${l.text}"`)],
  );
  for (const [k, l] of lines.entries()) {
    if (l.atMs >= e.durationMs) {
      issues.push(
        bad(`elements.${i}.speech.lines.${k}.atMs`, `atMs ${l.atMs} is not before the clip end ${e.durationMs}`),
      );
    }
  }
  return issues;
}

export function spokenWordList(lines: readonly { text: string }[]): string {
  return (
    lines
      .map(
        (l, k) =>
          `line ${k}: ${tokens(l.text)
            .filter((t) => t.bare !== '')
            .map((t) => t.bare)
            .join(', ')}`,
      )
      .join('; ') || 'there is no speech'
  );
}

function checkBeatAt(e: GenerateVideo, beat: Beat, path: string): BriefIssue[] {
  const lines = e.speech?.lines ?? [];
  const { at } = beat;
  if ('lineEnd' in at) {
    return at.lineEnd < lines.length
      ? []
      : [bad(`${path}.at.lineEnd`, `no line ${at.lineEnd}; there are ${lines.length}`)];
  }
  if (!('word' in at)) return [];
  if (wordAt(lines, at.word) === null) {
    return [bad(`${path}.at.word`, `no word contains "${at.word}" (${spokenWordList(lines)})`)];
  }
  if (beat.prompt !== undefined && !beat.prompt.includes(at.word)) {
    return [bad(`${path}.prompt`, `the sentence does not contain the word "${at.word}"`)];
  }
  return [];
}

function checkBeats(e: GenerateVideo, i: number): BriefIssue[] {
  const beats = e.beats ?? [];
  const issues = duplicates(
    beats.map((b) => b.id),
    (k) => `elements.${i}.beats.${k}.id`,
    'beat',
  );
  for (const [k, beat] of beats.entries()) {
    const path = `elements.${i}.beats.${k}`;
    if (beat.prompt !== undefined && !e.prompt.includes(beat.prompt)) {
      issues.push(bad(`${path}.prompt`, 'the prompt does not contain this sentence'));
    }
    issues.push(...checkBeatAt(e, beat, path));
  }
  return issues;
}

// assets/ is shared, not the work's own; a scene is a script the work carries itself.
function checkScene(e: GenerateVideo, i: number): BriefIssue[] {
  if (e.scene === undefined || (!e.scene.startsWith('assets/') && e.scene.endsWith('.mjs'))) return [];
  return [bad(`elements.${i}.scene`, `${e.scene} must be a .mjs file in the work folder`)];
}

function checkTimeline(e: GenerateVideo, i: number): BriefIssue[] {
  return [...checkSpeech(e, i), ...checkBeats(e, i), ...checkScene(e, i)];
}

// A model takes raster pictures only; an SVG sent as a reference would be refused after the estimate was spent.
function checkRefFiles(e: GenerateImage, i: number): BriefIssue[] {
  return (e.refs ?? []).flatMap((rel, k) =>
    IMAGE_FILE.test(rel) ? [] : [bad(`elements.${i}.refs.${k}`, `${rel} must be a png, jpeg or webp image`)],
  );
}

function checkGenerate(s: Scan, e: GenerateImage | GenerateVideo, i: number): BriefIssue[] {
  const { model, issues } = modelOf(s, e, i);
  issues.push(...checkPlacement(s, e, i));
  if (isImageGen(e)) issues.push(...checkRefFiles(e, i));
  if (isVideoGen(e)) {
    if (s.brief.kind === 'image')
      issues.push(bad(`elements.${i}.output`, 'an image brief cannot hold a generated video'));
    issues.push(...checkKeyframeSource(s, e, i), ...checkLastFrameFile(e, i), ...checkTimeline(e, i));
  }
  if (model === null) return issues;
  issues.push(...checkSize(s, e, i, model));
  issues.push(...(isVideoGen(e) ? checkVideo(s, e, i, model) : checkRefs(e, i, model)));
  return issues;
}

function checkFileElement(s: Scan, e: Element, i: number): BriefIssue[] {
  if (e.method === 'draw' || isGenerate(e)) return [];
  const video = isVideoLayer(e);
  const issues: BriefIssue[] = [];
  if (e.keepAudio !== undefined && !video) issues.push(bad(`elements.${i}.keepAudio`, 'keepAudio needs a video file'));
  if (video && s.brief.kind === 'image')
    issues.push(bad(`elements.${i}.file`, 'an image brief cannot hold a video file'));
  const svg = SVG_FILE.test(e.file);
  if (svg && e.method === 'capture') {
    issues.push(bad(`elements.${i}.file`, 'capture takes a screenshot or a screen recording, not an SVG'));
  }
  if (e.color !== undefined && !svg) {
    issues.push(bad(`elements.${i}.color`, `color fills currentColor in an SVG; ${e.file} is not one`));
  }
  return issues;
}

// A combining mark belongs to the letter before it, so é written as e + ◌́ is one letter.
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

// Where the phrase stands as whole words: no letter or digit right before or after it. Punctuation may touch it. The
// neighbours are whole code points, so a letter past the BMP is not read as half a surrogate pair.
export function markOccurrences(text: string, phrase: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(phrase); at >= 0; at = text.indexOf(phrase, at + 1)) {
    const before = [...text.slice(Math.max(0, at - 2), at)].at(-1) ?? '';
    const after = [...text.slice(at + phrase.length, at + phrase.length + 2)][0] ?? '';
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) found.push(at);
  }
  return found;
}

function checkDraw(e: Draw, i: number): BriefIssue[] {
  const { mark } = e;
  if (mark === undefined) return [];
  const at = `elements.${i}.mark`;
  if (e.text === undefined) return [bad(at, 'a shape has no text to mark')];
  if (mark.text.includes('\n')) return [bad(`${at}.text`, 'a mark sits on one line')];
  if (mark.text.trim() !== mark.text) return [bad(`${at}.text`, 'a mark starts and ends with a word')];
  const count = markOccurrences(e.text, mark.text).length;
  if (count === 1) return [];
  return [
    bad(
      `${at}.text`,
      count === 0
        ? `"${mark.text}" is not a whole word or phrase in the text`
        : `"${mark.text}" appears ${count} times in the text; mark one`,
    ),
  ];
}

function checkElements(s: Scan): BriefIssue[] {
  return s.brief.elements.flatMap((e, i) => {
    if (isGenerate(e)) return checkGenerate(s, e, i);
    return e.method === 'draw' ? checkDraw(e, i) : checkFileElement(s, e, i);
  });
}

// A clip keeps the frames its model made only when the brief runs at that model's rate. Not part of loadBrief, so
// works made before the rule still make; estimate refuses it before anything new is generated.
export function videoFpsIssue(brief: Brief, models: ReadonlyMap<string, ModelEntry>): BriefIssue | null {
  if (brief.kind !== 'video') return null;
  const made = new Map<string, number>();
  for (const e of brief.elements) {
    if (!isVideoGen(e)) continue;
    const fps = models.get(e.model)?.fps;
    if (fps !== undefined && fps !== null) made.set(e.model, fps);
  }
  const { fps } = brief.frame;
  if (made.size === 0 || [...made.values()].includes(fps)) return null;
  const list = [...made]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, f]) => `${id} ${f}`)
    .join(', ');
  return bad('frame.fps', `frame.fps ${fps} is not the fps of its video models: ${list}`);
}

// `given` marks a video's first- or last-frame file, which must also really sit under assets/ or inputs/.
type PathRef = { path: string; rel: string; licensed: boolean; given?: true };

function elementPaths(e: Element, i: number): PathRef[] {
  const at = `elements.${i}`;
  if (isImageGen(e)) return (e.refs ?? []).map((rel, k) => ({ path: `${at}.refs.${k}`, rel, licensed: false }));
  if (isVideoGen(e)) {
    const refs: PathRef[] = [];
    if (e.fromFile !== undefined) refs.push({ path: `${at}.fromFile`, rel: e.fromFile, licensed: false, given: true });
    if (e.toFile !== undefined) refs.push({ path: `${at}.toFile`, rel: e.toFile, licensed: false, given: true });
    if (e.scene !== undefined) refs.push({ path: `${at}.scene`, rel: e.scene, licensed: false });
    return refs;
  }
  if (e.method === 'draw') {
    return e.font?.startsWith('assets/') ? [{ path: `${at}.font`, rel: e.font, licensed: true }] : [];
  }
  return [{ path: `${at}.file`, rel: e.file, licensed: false }];
}

function pathRefs(brief: Brief): PathRef[] {
  const refs = brief.elements.flatMap(elementPaths);
  for (const [k, rel] of (brief.assets ?? []).entries()) refs.push({ path: `assets.${k}`, rel, licensed: false });
  if (brief.audio) refs.push({ path: 'audio.music', rel: brief.audio.music, licensed: true });
  return refs;
}

// A brief names shared assets from the studio folder and everything else from the work folder.
export function briefPath(ctx: BriefCtx, rel: string): string {
  return join(rel.startsWith('assets/') ? ctx.home : ctx.workDir, rel);
}

async function pathIssue(ctx: BriefCtx, ref: PathRef): Promise<BriefIssue | null> {
  try {
    // briefPath is absolute, so the base argument does not take part.
    await resolveInside([join(ctx.home, 'assets'), ctx.workDir], ctx.workDir, briefPath(ctx, ref.rel));
    return null;
  } catch (e) {
    if (e instanceof StudioError && e.code === 'NOT_FOUND') return bad(ref.path, `${ref.rel} does not exist`);
    if (e instanceof StudioError && e.code === 'BRIEF_INVALID') {
      return bad(ref.path, `${ref.rel} is outside assets/ and the work folder`);
    }
    throw e;
  }
}

// The text can name inputs/ and still lead into raw/ through `..` or a link, so the real location is checked too. A
// path whose text is outside them is already reported by checkGivenFile.
async function givenIssue(ctx: BriefCtx, ref: PathRef): Promise<BriefIssue | null> {
  if (ref.given !== true || !inGivenDir(ref.rel)) return null;
  // An inputs folder that is itself a link, say to raw/key/, would make its target count as inputs/.
  const inputs = join(ctx.workDir, 'inputs');
  const roots = [join(ctx.home, 'assets'), ...((await isLink(inputs)) ? [] : [inputs])];
  try {
    await resolveInside(roots, ctx.workDir, briefPath(ctx, ref.rel));
    return null;
  } catch (e) {
    if (e instanceof StudioError && e.code === 'BRIEF_INVALID') return bad(ref.path, givenDirReason(ref.rel));
    throw e;
  }
}

async function licenseIssue(ctx: BriefCtx, ref: PathRef): Promise<BriefIssue | null> {
  const missing = bad(ref.path, `${ref.rel} has no commercial-use licence record`, 'ASSET_LICENSE_MISSING');
  try {
    return (await licenseOf(ctx.home, ref.rel)) === null ? missing : null;
  } catch (e) {
    if (e instanceof StudioError && e.code === 'BRIEF_INVALID') {
      return bad(ref.path, `the asset.json covering ${ref.rel} is invalid`, 'ASSET_LICENSE_MISSING');
    }
    throw e;
  }
}

// The renderer and the models go by a picture's bytes, not its name, so an SVG named .png would skip the SVG checks.
async function pictureIssue(ctx: BriefCtx, ref: PathRef): Promise<BriefIssue | null> {
  const ext = ref.rel.match(IMAGE_FILE)?.[1]?.toLowerCase();
  if (ext === undefined) return null;
  const named: PictureFormat = ext === 'png' || ext === 'webp' ? ext : 'jpeg';
  const abs = briefPath(ctx, ref.rel);
  // A folder or a pipe named like a picture would fail, or hang, when read.
  if (!(await stat(abs)).isFile()) return bad(ref.path, `${ref.rel} is not a file`);
  return (await pictureFormat(abs)) === named ? null : bad(ref.path, `${ref.rel} is not a ${named} image`);
}

const DRIVE = /^[A-Za-z]:/;

// A brief moves between machines, so its paths have one form: a \ or a drive means something on one OS only, and a
// leading / reads as the disk root everywhere though briefPath joins it to the work folder.
function pathFormIssue(rel: string): string | null {
  const portable = !rel.includes('\\') && !rel.startsWith('/') && !DRIVE.test(rel);
  return portable ? null : 'use / and a path relative to the work folder or assets/';
}

async function checkOnePath(ctx: BriefCtx, ref: PathRef): Promise<BriefIssue[]> {
  const form = pathFormIssue(ref.rel);
  if (form !== null) return [bad(ref.path, form)];
  const found = (await pathIssue(ctx, ref)) ?? (await givenIssue(ctx, ref)) ?? (await pictureIssue(ctx, ref));
  if (found !== null) return [found];
  const unlicensed = ref.licensed ? await licenseIssue(ctx, ref) : null;
  return unlicensed === null ? [] : [unlicensed];
}

async function checkPaths(brief: Brief, ctx: BriefCtx): Promise<BriefIssue[]> {
  return (await Promise.all(pathRefs(brief).map((ref) => checkOnePath(ctx, ref)))).flat();
}

// make draws an SVG at each box's own size, so a box of another ratio would squash or crop the logo.
function ratioIssue(file: string, svg: { width: number; height: number }, p: Placement): BriefIssue | null {
  const [, , w, h] = p.box.rect;
  const fits = Math.round((w * svg.height) / svg.width);
  if (Math.abs(fits - h) <= 1) return null;
  return bad(`${p.path}.rect`, `${file} is ${svg.width}:${svg.height}; a ${w} px wide box needs height ${fits}`);
}

// The renderer, not the text checks, decides whether a file draws, so each box is drawn as make will draw it.
async function drawIssue(
  e: FileElement,
  i: number,
  svg: Svg,
  placements: readonly Placement[],
): Promise<BriefIssue | null> {
  for (const { box } of placements) {
    const drawn = await drawSvg(svg, box.rect[2], box.rect[3], e.color);
    if (drawn.kind === 'refused') return bad(`elements.${i}.file`, `${e.file} ${drawn.reason}`);
  }
  return null;
}

async function svgIssues(s: Scan, e: FileElement, i: number): Promise<BriefIssue[]> {
  const svg = await readSvg(briefPath(s.ctx, e.file));
  if (svg.kind === 'refused') return [bad(`elements.${i}.file`, `${e.file} ${svg.reason}`)];
  const placements = s.placements.get(e.id) ?? [];
  const undrawable = await drawIssue(e, i, svg, placements);
  const issues: BriefIssue[] = undrawable === null ? [] : [undrawable];
  if (svg.currentColor && e.color === undefined) {
    issues.push(bad(`elements.${i}.color`, `${e.file} uses currentColor; give it a color`));
  }
  if (!svg.currentColor && e.color !== undefined) {
    issues.push(bad(`elements.${i}.color`, `${e.file} does not use currentColor; drop color`));
  }
  for (const p of placements) {
    const issue = ratioIssue(e.file, svg, p);
    if (issue !== null) issues.push(issue);
  }
  return issues;
}

// Reads only files the path checks passed, so a missing or escaping file is reported once, by them.
async function checkSvgs(s: Scan, failed: ReadonlySet<string>): Promise<BriefIssue[]> {
  const checks = s.brief.elements.flatMap((e, i) =>
    e.method === 'composite' && SVG_FILE.test(e.file) && !failed.has(`elements.${i}.file`) ? [svgIssues(s, e, i)] : [],
  );
  return (await Promise.all(checks)).flat();
}

type Frame = { path: string; rel: string };

// generate measures every given frame: the first to choose among rows that differ only in ratio, the last against the
// first.
async function frameIssues(s: Scan, frames: readonly Frame[]): Promise<BriefIssue[]> {
  const read = await Promise.all(
    frames.map(async (f) => ({ ...f, stored: await storedSize(briefPath(s.ctx, f.rel)) })),
  );
  const sized = read.flatMap((f) => (f.stored.kind === 'size' ? [{ ...f, size: f.stored.size }] : []));
  if (sized.length < read.length) {
    return read.flatMap((f) =>
      f.stored.kind === 'size' ? [] : [bad(f.path, `${f.rel} has no readable picture size`)],
    );
  }
  const [first, last] = sized;
  if (first === undefined || last === undefined || sameRatio(first.size, last.size)) return [];
  const reason = `the last frame ${last.rel} is ${last.size[0]}x${last.size[1]}, not the ratio of the first frame ${first.size[0]}x${first.size[1]}`;
  return [bad(last.path, reason)];
}

// Reads each given frame whose path has no issue yet: it passed the path checks, so it exists, is a file and is the
// picture its name says, and a path gets one problem at a time. A video that has spent is not read: a paid take may
// stand on a frame older versions measured with ffprobe alone (an animated WebP or a cut PNG it took as 0x0, a JPEG
// with stray bytes), and its work must keep loading. generate checks again before any upload, for such a video, for a
// generated keyframe (`from`, which does not exist yet) and for a file changed since.
async function checkFrames(s: Scan, failed: ReadonlySet<string>): Promise<BriefIssue[]> {
  const checks = s.brief.elements.flatMap((e, i) => {
    if (!isVideoGen(e) || s.spent.has(e.id)) return [];
    const frames = [
      { path: `elements.${i}.fromFile`, rel: e.fromFile },
      { path: `elements.${i}.toFile`, rel: e.toFile },
    ].filter((f): f is Frame => f.rel !== undefined && !failed.has(f.path));
    return frames.length > 0 ? [frameIssues(s, frames)] : [];
  });
  return (await Promise.all(checks)).flat();
}

const ReadIssues = z.object({ issues: z.array(z.object({ path: z.string(), message: z.string() })) });

// Raw bytes, so any edit to brief.json (even whitespace) shows up as a changed brief.
export function briefHash(workDir: string): Promise<string> {
  return sha256File(join(workDir, BRIEF_FILE));
}

async function readBrief(workDir: string): Promise<{ value: Brief; sha256: string }> {
  try {
    return await readJsonHashed(join(workDir, BRIEF_FILE), briefSchema);
  } catch (e) {
    if (!(e instanceof StudioError) || e.code !== 'BRIEF_INVALID') throw e;
    const parsed = ReadIssues.safeParse(e.details);
    if (!parsed.success) throw e;
    const issues = parsed.data.issues.map((i) => bad(i.path, i.message));
    throw new StudioError('BRIEF_INVALID', `brief.json has ${issues.length} problem(s)`, { issues });
  }
}

export async function loadBrief(ctx: BriefCtx): Promise<Brief> {
  return (await loadBriefHashed(ctx)).brief;
}

// The hash names the exact bytes the brief was parsed from, so an approval or estimate made with it cannot pair
// this brief with a later edit of the file.
export async function loadBriefHashed(ctx: BriefCtx): Promise<{ brief: Brief; briefHash: string }> {
  const { value: brief, sha256 } = await readBrief(ctx.workDir);
  const s = scan(brief, ctx, new Set((await attempts(ctx.workDir)).map((a) => a.element)));
  const pathIssues = await checkPaths(brief, ctx);
  const earlier = [
    ...checkWork(s),
    ...checkIds(s),
    ...checkBoxes(s),
    ...checkZOrder(s),
    ...checkElements(s),
    ...pathIssues,
    ...(await checkSvgs(s, new Set(pathIssues.map((i) => i.path)))),
  ];
  const issues = [...earlier, ...(await checkFrames(s, new Set(earlier.map((i) => i.path))))];
  if (issues.length > 0) {
    throw new StudioError('BRIEF_INVALID', `brief has ${issues.length} problem(s)`, { issues });
  }
  return { brief, briefHash: sha256 };
}
