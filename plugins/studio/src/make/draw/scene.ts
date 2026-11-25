import { type Canvas, createCanvas, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import { StudioError } from '../../errors.ts';
import type { Box, Brief, Cut, Draw, Element, Method, Rect } from '../../works/index.ts';
import { type FontRoots, missingGlyphs, registerFonts } from './fonts.ts';
import { drawShape } from './shapes.ts';
import { drawText, layoutText, minTextSizePx, styleOf, type TextStyle, type TextWarning, textExtent } from './text.ts';

// Distinct hues that stay readable under white labels on the dark preview ground.
export const METHOD_COLORS: Readonly<Record<Method, string>> = {
  generate: '#c2571a',
  draw: '#17797a',
  capture: '#2a62a8',
  composite: '#5f7f1f',
};

const METHOD_NAMES: Readonly<Record<Method, string>> = {
  generate: 'generate',
  draw: 'draw',
  capture: 'capture',
  composite: 'composite',
};

export type ScenePurpose = 'preview' | 'overlay';

// Draws one element in its box's own coordinates (origin at the box's top-left); clipMs counts from the box's enter.
export type SceneDraw = (g: SKRSContext2D, clipMs: number) => void;

export const PREVIEW_GROUND = '#202124';
const TAG_COLOR = '#ffffff';
const TAG_FONT = 'pretendard-bold';
const ANIM_MS = 300;
const SLIDE_RATIO = 0.25;
const LEGEND_GAP_PX = 16;

type Frame = Brief['frame'];
type TextDraw = Draw & { text: string };

const isDrawText = (e: Element): e is TextDraw => e.method === 'draw' && e.text !== undefined;
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const tagSizePx = (frame: Frame): number => Math.max(12, Math.round(Math.min(frame.width, frame.height) * 0.03));

function layoutOf(brief: Brief, cut: Cut | null): readonly Box[] {
  if (brief.kind === 'image' && cut === null) return brief.layout;
  if (brief.kind === 'video' && cut !== null) return cut.layout;
  throw new StudioError('USAGE', 'an image takes no cut and a video needs one', { kind: brief.kind });
}

// Enter and exit are optional and default to the whole cut; a still has no timeline.
function spanOf(cut: Cut | null, box: Box): readonly [number, number] {
  if (cut === null) return [0, Number.POSITIVE_INFINITY];
  return [box.enterMs ?? 0, box.exitMs ?? cut.durationMs];
}

// The last frame of a cut (t = duration) still shows boxes that run to the cut end.
function isVisible(cut: Cut | null, box: Box, tMs: number): boolean {
  if (cut === null) return true;
  return tMs >= (box.enterMs ?? 0) && (box.exitMs === undefined || tMs < box.exitMs);
}

function animationAt(cut: Cut | null, box: Box, tMs: number): { alpha: number; dx: number } {
  if (cut === null || box.anim === undefined) return { alpha: 1, dx: 0 };
  const [enter, exit] = spanOf(cut, box);
  const inP = clamp01((tMs - enter) / ANIM_MS);
  const outP = clamp01((exit - tMs) / ANIM_MS);
  // Enters from the left and leaves to the right.
  const dx = box.anim === 'slide' ? box.rect[2] * SLIDE_RATIO * (inP - outP) : 0;
  return { alpha: Math.min(inP, outP), dx };
}

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

function applyCamera(ctx: SKRSContext2D, cut: Cut, frame: Frame, tMs: number): void {
  const camera = cut.camera;
  if (camera === undefined) return;
  const linear = clamp01(tMs / cut.durationMs);
  const t = camera.ease === 'inOut' ? smoothstep(linear) : linear;
  const [x, y, w, h] = camera.from.map((v, i) => lerp(v, camera.to[i] ?? v, t));
  if (x === undefined || y === undefined || !w || !h) return;
  const s = Math.min(frame.width / w, frame.height / h);
  ctx.translate((frame.width - w * s) / 2, (frame.height - h * s) / 2);
  ctx.scale(s, s);
  ctx.translate(-x, -y);
}

function fillRounded(ctx: SKRSContext2D, [x, y, w, h]: Rect, fill: string): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.08);
  ctx.fillStyle = fill;
  ctx.fill();
}

function drawTag(ctx: SKRSContext2D, label: string, [x, y, w]: Rect, sizePx: number): void {
  ctx.save();
  ctx.font = `${sizePx}px "${TAG_FONT}"`;
  ctx.fillStyle = TAG_COLOR;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const pad = Math.round(sizePx * 0.5);
  ctx.fillText(label, x + pad, y + pad, Math.max(1, w - pad * 2));
  ctx.restore();
}

function drawBlock(ctx: SKRSContext2D, el: Element, box: Box, frame: Frame): void {
  const tag = tagSizePx(frame);
  fillRounded(ctx, box.rect, METHOD_COLORS[el.method]);
  drawTag(ctx, el.label, box.rect, tag);
  for (const part of box.parts ?? []) {
    fillRounded(ctx, part.rect, 'rgba(255, 255, 255, 0.3)');
    drawTag(ctx, part.label, part.rect, Math.max(10, Math.round(tag * 0.75)));
  }
}

function drawCover(ctx: SKRSContext2D, image: Image, [x, y, w, h]: Rect): void {
  const s = Math.max(w / image.width, h / image.height);
  const sw = w / s;
  const sh = h / s;
  ctx.drawImage(image, (image.width - sw) / 2, (image.height - sh) / 2, sw, sh, x, y, w, h);
}

function drawDrawn(ctx: SKRSContext2D, el: Draw, box: Box, frame: Frame): void {
  if (isDrawText(el)) {
    const style = styleOf(el, frame);
    const laid = layoutText(ctx, el.text, box.rect, style, el.mark?.text);
    const mark = el.mark === undefined || laid.mark === null ? undefined : { ...el.mark, span: laid.mark };
    drawText(ctx, laid.lines, box.rect, style, el.color, mark);
  } else if (el.shape !== undefined) {
    drawShape(ctx, el.shape, box.rect, el.color);
  }
}

function drawScene(ctx: SKRSContext2D, draw: SceneDraw, box: Box, tMs: number): void {
  const [x, y, w, h] = box.rect;
  ctx.save();
  ctx.translate(x, y);
  // The scene may draw past its box; the clip keeps it from covering its neighbours.
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  draw(ctx, tMs - (box.enterMs ?? 0));
  ctx.restore();
}

function drawElement(
  ctx: SKRSContext2D,
  a: {
    el: Element;
    box: Box;
    frame: Frame;
    purpose: ScenePurpose;
    images: ReadonlyMap<Box, Image>;
    scene: SceneDraw | undefined;
    tMs: number;
  },
): void {
  const { el, box, frame, purpose, images, scene, tMs } = a;
  if (purpose === 'preview' && scene !== undefined) {
    drawScene(ctx, scene, box, tMs);
  } else if (el.method === 'draw') {
    drawDrawn(ctx, el, box, frame);
  } else if (purpose === 'preview') {
    drawBlock(ctx, el, box, frame);
  } else {
    // The overlay carries only what sits above the video: still images the caller has loaded, one per box.
    const image = images.get(box);
    if (image !== undefined) drawCover(ctx, image, box.rect);
  }
}

function drawLegend(ctx: SKRSContext2D, frame: Frame): void {
  const size = tagSizePx(frame);
  ctx.save();
  ctx.font = `${size}px "${TAG_FONT}"`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const methods = Object.keys(METHOD_COLORS) as Method[];
  const itemW = (m: Method): number => size * 1.4 + ctx.measureText(METHOD_NAMES[m]).width;
  const step = LEGEND_GAP_PX * 1.5;
  const y = frame.height - LEGEND_GAP_PX - size / 2;
  // A strip of the preview ground keeps each swatch apart from a block of its own colour underneath.
  const rowW = methods.reduce((sum, m) => sum + itemW(m), 0) + step * (methods.length - 1);
  const pad = LEGEND_GAP_PX / 2;
  ctx.fillStyle = PREVIEW_GROUND;
  ctx.fillRect(LEGEND_GAP_PX - pad, y - size / 2 - pad, rowW + 2 * pad, size + 2 * pad);
  let x = LEGEND_GAP_PX;
  for (const method of methods) {
    ctx.fillStyle = METHOD_COLORS[method];
    ctx.fillRect(x, y - size / 2, size, size);
    ctx.fillStyle = TAG_COLOR;
    ctx.fillText(METHOD_NAMES[method], x + size * 1.4, y);
    x += itemW(method) + step;
  }
  ctx.restore();
}

// Judged over the whole brief, not the current cut, so the legend does not flicker from cut to cut.
function hasBlock(brief: Brief, scenes: ReadonlyMap<string, SceneDraw>): boolean {
  const placed = new Set(boxesOf(brief).map((b) => b.element));
  return brief.elements.some((e) => e.method !== 'draw' && placed.has(e.id) && !scenes.has(e.id));
}

export function renderFrame(a: {
  brief: Brief;
  cut: Cut | null;
  tMs: number;
  purpose: ScenePurpose;
  scale: number;
  images: ReadonlyMap<Box, Image>;
  legend: boolean;
  scenes?: ReadonlyMap<string, SceneDraw>;
}): Canvas {
  const { brief, cut, tMs, purpose, scale, images, scenes } = a;
  const { frame } = brief;
  const boxes = layoutOf(brief, cut);
  const canvas = createCanvas(
    Math.max(1, Math.round(frame.width * scale)),
    Math.max(1, Math.round(frame.height * scale)),
  );
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  if (purpose === 'preview') {
    ctx.fillStyle = PREVIEW_GROUND;
    ctx.fillRect(0, 0, frame.width, frame.height);
    if (cut?.camera?.mode === 'digital') applyCamera(ctx, cut, frame, tMs);
  }
  const byId = new Map(brief.elements.map((e) => [e.id, e] as const));
  for (const box of boxes.toSorted((p, q) => p.z - q.z)) {
    const el = byId.get(box.element);
    if (el === undefined || !isVisible(cut, box, tMs)) continue;
    const { alpha, dx } = animationAt(cut, box, tMs);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(dx, 0);
    // A prompt camera moves only what the model made, and the clip slides with its box; the real composite never re-applies it.
    if (purpose === 'preview' && cut?.camera?.mode === 'prompt' && el.method === 'generate' && el.output === 'video') {
      const [x, y, w, h] = box.rect;
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      applyCamera(ctx, cut, frame, tMs);
    }
    drawElement(ctx, { el, box, frame, purpose, images, scene: scenes?.get(el.id), tMs });
    ctx.restore();
  }
  if (a.legend && purpose === 'preview' && (scenes === undefined || scenes.size === 0 || hasBlock(brief, scenes))) {
    ctx.resetTransform();
    ctx.scale(scale, scale);
    drawLegend(ctx, frame);
  }
  return canvas;
}

type Placed = {
  id: string;
  box: Box;
  style: TextStyle;
  overflow: boolean;
  extent: Rect;
  span: readonly [number, number];
};

const intersects = ([ax, ay, aw, ah]: Rect, [bx, by, bw, bh]: Rect): boolean =>
  ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;

const insideFrame = ([x, y, w, h]: Rect, frame: Frame): boolean =>
  x >= 0 && y >= 0 && x + w <= frame.width && y + h <= frame.height;

function warningsFor(p: Placed, all: readonly Placed[], frame: Frame): TextWarning[] {
  const kinds: TextWarning['kind'][] = [];
  if (p.overflow || !insideFrame(p.extent, frame)) kinds.push('cut_off');
  if (p.style.sizePx < minTextSizePx(frame)) kinds.push('too_small');
  const sharesTime = (q: Placed) => p.span[0] < q.span[1] && q.span[0] < p.span[1];
  if (all.some((q) => q !== p && sharesTime(q) && intersects(p.extent, q.extent))) kinds.push('overlap');
  return kinds.map((kind) => ({ element: p.id, kind }));
}

function placedTexts(ctx: SKRSContext2D, brief: Brief, cut: Cut | null, boxes: readonly Box[]): Placed[] {
  const texts = new Map(brief.elements.filter(isDrawText).map((e) => [e.id, e] as const));
  return boxes.flatMap((box) => {
    const el = texts.get(box.element);
    if (el === undefined) return [];
    const style = styleOf(el, brief.frame);
    const { lines, overflow, mark } = layoutText(ctx, el.text, box.rect, style, el.mark?.text);
    const extent = textExtent(ctx, lines, box.rect, style, mark);
    return [{ id: el.id, box, style, overflow, extent, span: spanOf(cut, box) }];
  });
}

type GlyphFailure = { element: string; field: 'text' | 'label' | 'part label'; chars: string[] };

const boxesOf = (brief: Brief): readonly Box[] =>
  brief.kind === 'image' ? brief.layout : brief.cuts.flatMap((cut) => cut.layout);

// A character the font cannot draw would come out as a blank box, so it stops the brief instead of warning.
// Draw text is checked in its own font. The layout reference draws labels in the tag font, and its bytes feed the
// input fingerprint, so a system-font fallback there would make them machine-dependent.
async function assertGlyphs(brief: Brief): Promise<void> {
  const failures: GlyphFailure[] = [];
  const seen = new Set<string>();
  const check = async (element: string, field: GlyphFailure['field'], font: string, text: string): Promise<void> => {
    const key = JSON.stringify([element, field, text]);
    if (seen.has(key)) return;
    seen.add(key);
    const chars = await missingGlyphs(font, text);
    if (chars.length > 0) failures.push({ element, field, chars });
  };
  for (const el of brief.elements) {
    if (isDrawText(el)) await check(el.id, 'text', styleOf(el, brief.frame).font, el.text);
    else if (el.method === 'generate' && el.output === 'image' && el.layoutRef === true) {
      await check(el.id, 'label', TAG_FONT, el.label);
    }
  }
  for (const box of boxesOf(brief)) {
    for (const part of box.parts ?? []) await check(box.element, 'part label', TAG_FONT, part.label);
  }
  if (failures.length > 0) {
    const names = failures.map((f) => `${f.element} ${f.field}: ${f.chars.join('')}`).join(', ');
    throw new StudioError('BRIEF_INVALID', `the font has no glyph for some characters (${names})`, failures);
  }
}

// The canvas ignores a colour it cannot parse and keeps the previous one, so a typo would draw in some other colour.
// A value is a colour when it overrides two different starting colours to the same result.
function isColor(ctx: SKRSContext2D, value: string): boolean {
  ctx.fillStyle = '#010203';
  ctx.fillStyle = value;
  const fromFirst = ctx.fillStyle;
  ctx.fillStyle = '#040506';
  ctx.fillStyle = value;
  return ctx.fillStyle === fromFirst;
}

// The colours an element paints with, by the path the brief checks report them under.
function colorsOf(el: Element, i: number): { path: string; value: string }[] {
  if (el.method === 'draw') {
    const own = { path: `elements.${i}.color`, value: el.color };
    if (el.mark === undefined) return [own];
    return [
      own,
      { path: `elements.${i}.mark.color`, value: el.mark.color },
      { path: `elements.${i}.mark.textColor`, value: el.mark.textColor },
    ];
  }
  if (el.method === 'generate' || el.color === undefined) return [];
  return [{ path: `elements.${i}.color`, value: el.color }];
}

function assertColors(ctx: SKRSContext2D, brief: Brief): void {
  const issues = brief.elements.flatMap((el, i) =>
    colorsOf(el, i).flatMap(({ path, value }) =>
      isColor(ctx, value) ? [] : [{ path, code: 'BRIEF_INVALID', reason: `not a CSS colour: ${value}` }],
    ),
  );
  if (issues.length > 0) {
    throw new StudioError('BRIEF_INVALID', `brief has ${issues.length} colour(s) the canvas cannot draw`, { issues });
  }
}

export async function textChecks(roots: FontRoots, brief: Brief): Promise<TextWarning[]> {
  await registerFonts(roots, brief);
  await assertGlyphs(brief);
  const ctx = createCanvas(1, 1).getContext('2d');
  assertColors(ctx, brief);
  const layouts: [Cut | null, readonly Box[]][] =
    brief.kind === 'image' ? [[null, brief.layout]] : brief.cuts.map((cut) => [cut, cut.layout]);
  const seen = new Set<string>();
  const out: TextWarning[] = [];
  for (const [cut, boxes] of layouts) {
    const placed = placedTexts(ctx, brief, cut, boxes);
    for (const w of placed.flatMap((p) => warningsFor(p, placed, brief.frame))) {
      const key = `${w.element}/${w.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(w);
    }
  }
  return out;
}
