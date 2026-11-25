import { type Beat, type Box, type GenerateVideo, type Rect, spokenWordList, wordAt } from '../../works/index.ts';
import { mouthAt, type SpokenLine } from './voice.ts';

export type ResolvedBeat = { id: string; label: string; startMs: number; endMs: number; previewOnly: boolean };
type Span = { startMs: number; endMs: number };

export type SceneApi = {
  durationMs: number;
  box: { w: number; h: number };
  parts: { label: string; rect: Rect }[];
  part(label: string): Rect;
  word(w: string): number;
  line(i: number): Span;
  beat(id: string): Span;
  mouth(tMs: number): number;
};

const lineNumbers = (lines: readonly SpokenLine[]): string => lines.map((_, i) => i).join(', ') || 'none';

function lineAt(lines: readonly SpokenLine[], i: number): SpokenLine {
  const l = lines[i];
  if (l === undefined) throw new Error(`there is no line ${i} (lines: ${lineNumbers(lines)})`);
  return l;
}

function wordStart(lines: readonly SpokenLine[], word: string): number {
  const found = wordAt(lines, word);
  const startMs = found === null ? undefined : lines[found.line]?.words[found.index]?.startMs;
  if (startMs === undefined) throw new Error(`no word contains "${word}" (${spokenWordList(lines)})`);
  return startMs;
}

function startOf(at: Beat['at'], lines: readonly SpokenLine[]): number {
  if ('word' in at) return wordStart(lines, at.word);
  if ('lineEnd' in at) return lineAt(lines, at.lineEnd).endMs;
  return at.ms;
}

export function resolveBeats(beats: readonly Beat[], lines: readonly SpokenLine[]): ResolvedBeat[] {
  return beats.map((b) => {
    const startMs = startOf(b.at, lines) + (b.offsetMs ?? 0);
    return {
      id: b.id,
      label: b.label,
      startMs,
      endMs: startMs + (b.durationMs ?? 0),
      previewOnly: b.previewOnly === true,
    };
  });
}

export function sceneApi(a: {
  el: GenerateVideo;
  box: Box;
  lines: readonly SpokenLine[];
  beats: readonly ResolvedBeat[];
}): SceneApi {
  const [bx, by, w, h] = a.box.rect;
  const parts = (a.box.parts ?? []).map((p): { label: string; rect: Rect } => ({
    label: p.label,
    rect: [p.rect[0] - bx, p.rect[1] - by, p.rect[2], p.rect[3]],
  }));
  return {
    durationMs: a.el.durationMs,
    box: { w, h },
    parts,
    part(label) {
      const p = parts.find((x) => x.label === label);
      if (p === undefined) {
        throw new Error(`no part "${label}" (parts: ${parts.map((x) => x.label).join(', ') || 'none'})`);
      }
      return p.rect;
    },
    word: (word) => wordStart(a.lines, word),
    line(i) {
      const { startMs, endMs } = lineAt(a.lines, i);
      return { startMs, endMs };
    },
    beat(id) {
      const b = a.beats.find((x) => x.id === id);
      if (b === undefined) throw new Error(`no beat "${id}" (beats: ${a.beats.map((x) => x.id).join(', ') || 'none'})`);
      return { startMs: b.startMs, endMs: b.endMs };
    },
    mouth: (tMs) => mouthAt(a.lines, tMs),
  };
}
