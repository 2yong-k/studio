import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { GlobalFonts } from '@napi-rs/canvas';
import { create, type Font } from 'fontkit';
import { StudioError } from '../../errors.ts';
import type { Brief } from '../../works/index.ts';

export const DEFAULT_FONT = 'pretendard-regular';

const FONT_DIR = 'fonts';
const BUILTIN: Readonly<Record<string, string>> = {
  'pretendard-regular': join(FONT_DIR, 'Pretendard-Regular.otf'),
  'pretendard-bold': join(FONT_DIR, 'Pretendard-Bold.otf'),
  'inter-regular': join(FONT_DIR, 'Inter-Regular-latin.ttf'),
  'instrument-serif-regular': join(FONT_DIR, 'InstrumentSerif-Regular-latin.ttf'),
};
const ASSET_FONT_DIR = join('assets', 'fonts');

// The glyph tables that decide what a font can draw; the canvas has no per-character query of its own.
const glyphFonts = new Map<string, { file: string; font: Font }>();

// Built-in fonts ship with the code; a brief's `assets/fonts/` files belong to the studio folder.
export type FontRoots = { codeRoot: string; home: string };

// The brief schema only checks the `assets/fonts/` prefix; `..` must not lead out of that folder.
function assetFontFile(home: string, id: string): string {
  const file = resolve(home, id);
  if (!file.startsWith(join(resolve(home), ASSET_FONT_DIR) + sep)) {
    throw new StudioError('BRIEF_INVALID', `font is outside assets/fonts: ${id}`, { font: id });
  }
  return file;
}

function extraFontIds(brief: Brief): string[] {
  const ids = new Set<string>();
  for (const e of brief.elements) {
    if (e.method === 'draw' && e.font !== undefined && BUILTIN[e.font] === undefined) ids.add(e.font);
  }
  return [...ids];
}

async function registerOne(id: string, file: string): Promise<void> {
  if (glyphFonts.get(id)?.file === file) return;
  const bytes = await readFile(file).catch((e: unknown) => {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
      throw new StudioError('NOT_FOUND', `font file not found: ${id}`, { font: id });
    }
    throw e;
  });
  const parsed = create(bytes);
  // A collection file holds several faces; the first is the one the canvas registers under the alias too.
  const font = 'fonts' in parsed ? parsed.fonts[0] : parsed;
  if (font === undefined || GlobalFonts.registerFromPath(file, id) === null) {
    throw new StudioError('BRIEF_INVALID', `font cannot be loaded: ${id}`, { font: id });
  }
  glyphFonts.set(id, { file, font });
}

// For drawing that has no brief (contact sheets): only the fonts that ship with the code.
export async function registerBuiltinFonts(codeRoot: string): Promise<void> {
  for (const [id, rel] of Object.entries(BUILTIN)) await registerOne(id, join(codeRoot, rel));
}

export async function registerFonts(roots: FontRoots, brief: Brief): Promise<void> {
  await registerBuiltinFonts(roots.codeRoot);
  for (const id of extraFontIds(brief)) await registerOne(id, assetFontFile(roots.home, id));
}

function isBlank(ch: string): boolean {
  return /^\s$/u.test(ch);
}

export async function missingGlyphs(fontId: string, text: string): Promise<string[]> {
  const entry = glyphFonts.get(fontId);
  if (entry === undefined) throw new StudioError('USAGE', `font is not registered: ${fontId}`, { font: fontId });
  const missing: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || isBlank(ch) || missing.includes(ch)) continue;
    if (!entry.font.hasGlyphForCodePoint(cp)) missing.push(ch);
  }
  return missing;
}
