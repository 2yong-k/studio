import type { SKRSContext2D } from '@napi-rs/canvas';
import { type Draw, markOccurrences, type Rect } from '../../works/index.ts';
import { DEFAULT_FONT } from './fonts.ts';

export type TextWarning = { element: string; kind: 'cut_off' | 'overlap' | 'too_small' };
export type TextStyle = {
  font: string;
  sizePx: number;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle';
  letterSpacingPx: number;
  lineHeightPx: number;
};

// Where a marked phrase sits in lines[line], by character.
export type MarkSpan = { line: number; start: number; end: number };
export type MarkPaint = { span: MarkSpan; color: string; textColor: string };

const LINE_HEIGHT = 1.3;
// The brand Mark band, in em of the text size: the phrase takes this much more room on each side in the line, the
// band rises this far above the line top, is this tall, and its top edge sits this far right of its bottom edge.
const MARK_PAD_EM = 0.2;
const MARK_RISE_EM = 0.075;
const MARK_HEIGHT_EM = 1.15;
const MARK_SLANT_EM = 0.2;
// Used when the brief names no size: twice the "too small" floor, so an unsized text is never flagged by default.
const DEFAULT_SIZE_RATIO = 0.05;
const MIN_SIZE_RATIO = 0.025;

export const minTextSizePx = (frame: { width: number; height: number }): number =>
  Math.round(Math.min(frame.width, frame.height) * MIN_SIZE_RATIO);

export function styleOf(draw: Draw, frame: { width: number; height: number }): TextStyle {
  const sizePx = draw.sizePx ?? Math.round(Math.min(frame.width, frame.height) * DEFAULT_SIZE_RATIO);
  return {
    font: draw.font ?? DEFAULT_FONT,
    sizePx,
    align: draw.align ?? 'left',
    valign: draw.valign ?? 'top',
    letterSpacingPx: draw.letterSpacingPx ?? 0,
    lineHeightPx: draw.lineHeightPx ?? Math.round(sizePx * LINE_HEIGHT),
  };
}

// Callers measuring outside drawText wrap this in save/restore, so the spacing never reaches other text (tags).
function applyFont(ctx: SKRSContext2D, style: TextStyle): void {
  ctx.font = `${style.sizePx}px "${style.font}"`;
  ctx.letterSpacing = `${style.letterSpacingPx}px`;
}

// A line holding the marked phrase is wider by the band's room on both sides; any other line is measured whole.
function lineWidth(ctx: SKRSContext2D, line: string, span: { start: number; end: number } | null, em: number): number {
  const m = (s: string): number => ctx.measureText(s).width;
  if (span === null) return m(line);
  const { start, end } = span;
  return m(line.slice(0, start)) + m(line.slice(start, end)) + 2 * MARK_PAD_EM * em + m(line.slice(end));
}

// The word (by index) that holds the marked phrase, and where the phrase starts in it.
type MarkedWord = { index: number; offset: number; length: number };

// Whole words first, so only a word wider than the box is split by characters. The marked word is never split.
function wrapWords(
  ctx: SKRSContext2D,
  words: readonly string[],
  maxWidth: number,
  em: number,
  marked: MarkedWord | null,
): { lines: string[]; mark: { line: number; start: number } | null } {
  const lines: string[] = [];
  let mark: { line: number; start: number } | null = null;
  let line = '';
  let start: number | null = null;
  const fits = (s: string, at: number | null): boolean =>
    lineWidth(ctx, s, at === null || marked === null ? null : { start: at, end: at + marked.length }, em) <= maxWidth;
  const push = (): void => {
    if (start !== null) mark = { line: lines.length, start };
    lines.push(line);
    line = '';
    start = null;
  };
  for (const [i, word] of words.entries()) {
    const joined = line === '' ? word : `${line} ${word}`;
    const at: number | null = i === marked?.index ? joined.length - word.length + marked.offset : start;
    if (fits(joined, at)) {
      line = joined;
      start = at;
      continue;
    }
    if (line !== '') push();
    if (i === marked?.index) {
      line = word;
      start = marked.offset;
      continue;
    }
    for (const ch of word) {
      if (line === '' || fits(line + ch, null)) line += ch;
      else {
        push();
        line = ch;
      }
    }
  }
  push();
  return { lines, mark };
}

// The phrase and whatever touches it up to the spaces around it (punctuation) wrap as one word.
function markedWords(paragraph: string, at: number, length: number): { words: string[]; marked: MarkedWord } {
  const from = paragraph.lastIndexOf(' ', at - 1) + 1;
  const to = paragraph.indexOf(' ', at + length);
  const end = to < 0 ? paragraph.length : to;
  const before = from === 0 ? [] : paragraph.slice(0, from - 1).split(' ');
  const after = end === paragraph.length ? [] : paragraph.slice(end + 1).split(' ');
  return {
    words: [...before, paragraph.slice(from, end), ...after],
    marked: { index: before.length, offset: at - from, length },
  };
}

const spanOn = (i: number, mark: MarkSpan | null | undefined): MarkSpan | null => (mark?.line === i ? mark : null);

export function layoutText(
  ctx: SKRSContext2D,
  text: string,
  box: Rect,
  style: TextStyle,
  mark?: string,
): { lines: string[]; mark: MarkSpan | null; overflow: boolean } {
  ctx.save();
  applyFont(ctx, style);
  const [, , w, h] = box;
  const em = style.sizePx;
  // The brief allows one whole-word occurrence; without one the text is laid out unmarked.
  const at = mark === undefined ? undefined : markOccurrences(text, mark)[0];
  const lines: string[] = [];
  let span: MarkSpan | null = null;
  let offset = 0;
  for (const p of text.split('\n')) {
    const local = at !== undefined && mark !== undefined && at >= offset && at < offset + p.length ? at - offset : null;
    const { words, marked } =
      local === null || mark === undefined ? { words: p.split(' '), marked: null } : markedWords(p, local, mark.length);
    const wrapped = wrapWords(ctx, words, w, em, marked);
    if (wrapped.mark !== null && mark !== undefined) {
      span = {
        line: lines.length + wrapped.mark.line,
        start: wrapped.mark.start,
        end: wrapped.mark.start + mark.length,
      };
    }
    lines.push(...wrapped.lines);
    offset += p.length + 1;
  }
  const tooTall = lines.length * style.lineHeightPx > h;
  // A single character, or a marked phrase, wider than the box cannot be wrapped further.
  const tooWide = lines.some((l, i) => lineWidth(ctx, l, spanOn(i, span), em) > w);
  ctx.restore();
  return { lines, mark: span, overflow: tooTall || tooWide };
}

// Where the first line's top goes. `middle` centres the painted ink rather than the line boxes, since a line box
// leaves more room under the glyphs than above them. Whole pixels, so the extent is exactly where the text is drawn.
function firstLineTop(ctx: SKRSContext2D, lines: readonly string[], [, y, , h]: Rect, style: TextStyle): number {
  if (style.valign === 'top') return y;
  ctx.save();
  // The ink is measured from the baseline the lines are drawn on.
  ctx.textBaseline = 'top';
  const inkTop = -ctx.measureText(lines[0] ?? '').actualBoundingBoxAscent;
  const lastDescent = ctx.measureText(lines.at(-1) ?? '').actualBoundingBoxDescent;
  ctx.restore();
  const inkBottom = style.lineHeightPx * (lines.length - 1) + lastDescent;
  return y + Math.round(h / 2 - (inkTop + inkBottom) / 2);
}

// The area the line boxes and the Mark band cover. `middle` centres the line block on the box (the ink sits inside
// it), so it leaves the box only when the text overflows.
export function textExtent(
  ctx: SKRSContext2D,
  lines: readonly string[],
  box: Rect,
  style: TextStyle,
  mark?: MarkSpan | null,
): Rect {
  ctx.save();
  applyFont(ctx, style);
  const [x, , w] = box;
  const width = Math.ceil(Math.max(0, ...lines.map((l, i) => lineWidth(ctx, l, spanOn(i, mark), style.sizePx))));
  // The band follows the drawn lines, which `middle` places by their ink rather than by the line block.
  const drawnTop = firstLineTop(ctx, lines, box, style);
  ctx.restore();
  const left = style.align === 'left' ? x : style.align === 'center' ? x + (w - width) / 2 : x + w - width;
  const height = lines.length * style.lineHeightPx;
  const top = style.valign === 'top' ? box[1] : box[1] + Math.round((box[3] - height) / 2);
  if (mark === undefined || mark === null) return [Math.floor(left), top, width, height];
  const bandTop = drawnTop + mark.line * style.lineHeightPx - MARK_RISE_EM * style.sizePx;
  const y0 = Math.floor(Math.min(top, bandTop));
  const y1 = Math.ceil(Math.max(top + height, bandTop + MARK_HEIGHT_EM * style.sizePx));
  return [Math.floor(left), y0, width, y1 - y0];
}

// Where the marked line starts (x0) and where its phrase's room starts (s), with the phrase width (p).
function markedLine(
  ctx: SKRSContext2D,
  line: string,
  span: MarkSpan,
  [x, , w]: Rect,
  style: TextStyle,
): { x0: number; s: number; p: number } {
  const width = lineWidth(ctx, line, span, style.sizePx);
  const x0 = style.align === 'left' ? x : style.align === 'center' ? x + (w - width) / 2 : x + w - width;
  const s = x0 + ctx.measureText(line.slice(0, span.start)).width;
  return { x0, s, p: ctx.measureText(line.slice(span.start, span.end)).width };
}

// A parallelogram under the phrase's room: the bottom edge spans [s, s + p + 2·pad − slant], the top edge is slant to
// the right of it, so at mid height the band runs 0.1em past the phrase on each side.
function drawBand(ctx: SKRSContext2D, at: { s: number; p: number; top: number }, em: number, color: string): void {
  const { s, p, top } = at;
  const y0 = top - MARK_RISE_EM * em;
  const y1 = y0 + MARK_HEIGHT_EM * em;
  const right = s + p + 2 * MARK_PAD_EM * em;
  ctx.beginPath();
  ctx.moveTo(s + MARK_SLANT_EM * em, y0);
  ctx.lineTo(right, y0);
  ctx.lineTo(right - MARK_SLANT_EM * em, y1);
  ctx.lineTo(s, y1);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawMarkedLine(
  ctx: SKRSContext2D,
  line: string,
  at: { x0: number; s: number; p: number; top: number },
  paint: MarkPaint,
  a: { em: number; color: string },
): void {
  const { start, end } = paint.span;
  const pad = MARK_PAD_EM * a.em;
  ctx.save();
  ctx.textAlign = 'left';
  ctx.fillText(line.slice(0, start), at.x0, at.top);
  ctx.fillStyle = paint.textColor;
  ctx.fillText(line.slice(start, end), at.s + pad, at.top);
  ctx.fillStyle = a.color;
  ctx.fillText(line.slice(end), at.s + at.p + 2 * pad, at.top);
  ctx.restore();
}

export function drawText(
  ctx: SKRSContext2D,
  lines: readonly string[],
  box: Rect,
  style: TextStyle,
  color: string,
  mark?: MarkPaint,
): void {
  const [x, , w] = box;
  ctx.save();
  applyFont(ctx, style);
  ctx.fillStyle = color;
  ctx.textAlign = style.align;
  ctx.textBaseline = 'top';
  const anchor = style.align === 'left' ? x : style.align === 'center' ? x + w / 2 : x + w;
  const top = firstLineTop(ctx, lines, box, style);
  const step = style.lineHeightPx;
  const em = style.sizePx;
  const markLine = mark === undefined ? undefined : lines[mark.span.line];
  // The band goes under every glyph of the element, so it is drawn before any line.
  const at =
    mark === undefined || markLine === undefined
      ? null
      : { ...markedLine(ctx, markLine, mark.span, box, style), top: top + mark.span.line * step };
  if (at !== null && mark !== undefined) {
    drawBand(ctx, at, em, mark.color);
    ctx.fillStyle = color;
  }
  for (const [i, line] of lines.entries()) {
    if (at !== null && mark !== undefined && i === mark.span.line) drawMarkedLine(ctx, line, at, mark, { em, color });
    else ctx.fillText(line, anchor, top + i * step);
  }
  ctx.restore();
}
