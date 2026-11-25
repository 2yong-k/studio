import { readFile, stat } from 'node:fs/promises';
import { type Image, loadImage } from '@napi-rs/canvas';

export const SVG_FILE = /\.svg$/i;
// Brand SVGs are a few KB; anything this large is not a logo.
export const SVG_MAX_BYTES = 1_048_576;

export type Svg = { kind: 'svg'; width: number; height: number; currentColor: boolean; source: string };
export type SvgRead = Svg | { kind: 'refused'; reason: string };
export type SvgDrawn = { kind: 'drawn'; image: Image } | { kind: 'refused'; reason: string };

// Anything that could make the renderer read past the brief, or draw text in a machine-dependent font. The check is a
// search over the whole text, comments included, so a doubtful file is refused rather than parsed. The renderer follows
// namespace prefixes (<s:text> is <text>), and a character reference or CSS escape could spell url( or @import.
const FORBIDDEN: readonly RegExp[] = [
  /<(?:[^\s<>/:!?]+:)?(?:script|foreignObject|image|feImage|style|text)/i,
  /<!DOCTYPE/i,
  /<!ENTITY/i,
  /<\?xml-stylesheet/i,
  /(?:xlink:)?href\s*=\s*(?:"(?!#)[^"]*"|'(?!#)[^']*')/i,
  /url\(\s*(?!["']?#)["']?[^"')\s]*/i,
  /@import/i,
  /&#/,
  /\\/,
];

// Comments and processing instructions are not drawn, and may hold text that looks like the root.
const NOT_DRAWN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g;
const ROOT = /<svg\b(?:[^>"']|"[^"]*"|'[^']*')*>/;
// XML names its attributes exactly, so viewbox is not viewBox, and a value ends only at its own quote.
const ATTR = /\s+([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;
const TAG_END = /^\s*(\/?)>$/;
const CURRENT_COLOR = /currentcolor/i;
const NUMBER = /^\d+(?:\.\d+)?$/;
const PX_LENGTH = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i;

const refused = (reason: string): SvgRead => ({ kind: 'refused', reason });

type Attr = { name: string; value: string; text: string };
type Root = { attrs: Attr[]; selfClosing: boolean };

function readRoot(tag: string): Root | null {
  const attrs: Attr[] = [];
  let end = '<svg'.length;
  for (const m of tag.slice(end).matchAll(ATTR)) {
    attrs.push({ name: m[1] ?? '', value: m[2] ?? m[3] ?? '', text: m[0] });
    end += m[0].length;
  }
  const close = tag.slice(end).match(TAG_END);
  return close === null ? null : { attrs, selfClosing: close[1] === '/' };
}

const attr = (root: Root, name: string): string | null => root.attrs.find((a) => a.name === name)?.value ?? null;

const positive = (w: string | undefined, h: string | undefined): { width: number; height: number } | null => {
  if (w === undefined || h === undefined || !NUMBER.test(w) || !NUMBER.test(h)) return null;
  const [width, height] = [Number(w), Number(h)];
  return width > 0 && height > 0 ? { width, height } : null;
};

// A viewBox that is there but unreadable is refused, not passed over for width and height.
function sizeOf(root: Root): { width: number; height: number } | null {
  const box = attr(root, 'viewBox');
  if (box !== null) {
    const parts = box.trim().split(/[\s,]+/);
    return parts.length === 4 ? positive(parts[2], parts[3]) : null;
  }
  return positive(attr(root, 'width')?.match(PX_LENGTH)?.[1], attr(root, 'height')?.match(PX_LENGTH)?.[1]);
}

export function inspectSvg(bytes: Uint8Array): SvgRead {
  if (bytes.byteLength > SVG_MAX_BYTES) return refused('is over 1 MB');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return refused('is not UTF-8 text');
  }
  for (const pattern of FORBIDDEN) {
    const found = text.match(pattern)?.[0];
    if (found !== undefined) return refused(`contains ${found}`);
  }
  const source = text.replace(NOT_DRAWN, '');
  const tag = source.match(ROOT)?.[0];
  if (tag === undefined) return refused('has no <svg> root');
  const root = readRoot(tag);
  if (root === null) return refused('has an <svg> root tag it cannot read');
  const size = sizeOf(root);
  if (size === null) return refused('has no viewBox or px width and height');
  return { kind: 'svg', ...size, currentColor: CURRENT_COLOR.test(source), source };
}

export async function readSvg(abs: string): Promise<SvgRead> {
  const info = await stat(abs);
  // A folder or a pipe named like an SVG would fail, or hang, when read.
  if (!info.isFile()) return refused('is not a file');
  if (info.size > SVG_MAX_BYTES) return refused('is over 1 MB');
  return inspectSvg(await readFile(abs));
}

const escapeXml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c);

// The renderer rasterises at the root's width and height, so the box size goes there; a root sized only by width and
// height gets the matching viewBox so its drawing scales with it. A repeated attribute makes the SVG unreadable.
export function sizedSvg(svg: Svg, w: number, h: number, color: string | undefined): Buffer {
  const resized = svg.source.replace(ROOT, (tag) => {
    const root = readRoot(tag);
    if (root === null) throw new Error('sizedSvg takes only an SVG that inspectSvg read');
    const kept = root.attrs.filter((a) => a.name !== 'width' && a.name !== 'height').map((a) => a.text);
    const box = attr(root, 'viewBox') === null ? ` viewBox="0 0 ${svg.width} ${svg.height}"` : '';
    return `<svg${kept.join('')}${box} width="${w}" height="${h}"${root.selfClosing ? '/' : ''}>`;
  });
  const painted = color === undefined ? resized : resized.replace(/currentcolor/gi, escapeXml(color));
  return Buffer.from(painted);
}

// The text checks cannot tell whether the renderer will take the file, so the brief checks draw it as make will.
export async function drawSvg(svg: Svg, w: number, h: number, color: string | undefined): Promise<SvgDrawn> {
  const sized = sizedSvg(svg, w, h, color);
  let image: Image;
  try {
    image = await loadImage(sized);
  } catch (e) {
    return { kind: 'refused', reason: `cannot be drawn: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (image.width === w && image.height === h) return { kind: 'drawn', image };
  return { kind: 'refused', reason: `draws at ${image.width}x${image.height}, not at its box size ${w}x${h}` };
}
