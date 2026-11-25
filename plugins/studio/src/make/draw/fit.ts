import { type Canvas, createCanvas, type Image, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import type { Rect } from '../../works/index.ts';

// Tuned pixel thresholds for finding the subject on a flat paper background; EDGE, FEATHER and MIN_TILE are set below.
const RING = 40; // the border band the paper colour is sampled from
const STEP = 4;
const INK_DIFF = 60; // a pixel with a channel this far from the paper is printed
const MIN_RUN = 6; // a row or column needs more printed pixels than this, so specks of ink drop out
const MARGIN = 24; // paper this close to the subject may still carry its shadow, so the strip stays clear of it
// A generated picture's outer rows and columns are off-colour, darker in one print and lighter for 6 px then darker
// to 12 px in another; mirrored, they show as lines. Picture pixels, dropped from every side of the strip.
const EDGE = 16;
const FEATHER = 64; // the widest soft band at the picture's edges, in drawn pixels
// A smaller tile repeats too often to pass for paper, and mirroring it costs a draw call every few pixels.
const MIN_TILE = 32;

type Pixels = { data: Uint8ClampedArray; width: number; height: number };
type Rgb = [number, number, number];
type Subject = { paper: Rgb; bbox: Rect };
type Bands = [left: number, top: number, right: number, bottom: number];
export type Fitted =
  | { kind: 'fitted'; image: Image }
  | { kind: 'no-subject' }
  | { kind: 'no-paper' }
  | { kind: 'too-small' };

const median = (xs: number[]): number => xs.sort((a, b) => a - b)[xs.length >> 1] ?? 0;

function paperOf({ data, width, height }: Pixels): Rgb {
  const ch: [number[], number[], number[]] = [[], [], []];
  for (let y = 0; y < height; y += STEP) {
    for (let x = 0; x < width; x += STEP) {
      if (x >= RING && x < width - RING && y >= RING && y < height - RING) continue;
      const i = (y * width + x) * 4;
      ch.forEach((c, k) => {
        c.push(data[i + k] ?? 0);
      });
    }
  }
  return [median(ch[0]), median(ch[1]), median(ch[2])];
}

// Paper is whatever the border mostly shows, so the subject must leave most of the border bare.
export function measureSubject(px: Pixels): Subject | null {
  const { data, width, height } = px;
  const paper = paperOf(px);
  const far = (i: number): boolean => paper.some((p, k) => Math.abs((data[i + k] ?? 0) - p) > INK_DIFF);
  const rows = new Uint32Array(height);
  const cols = new Uint32Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!far((y * width + x) * 4)) continue;
      rows[y] = (rows[y] ?? 0) + 1;
      cols[x] = (cols[x] ?? 0) + 1;
    }
  }
  const counts = (n: number): boolean => n > MIN_RUN;
  const x0 = cols.findIndex(counts);
  const y0 = rows.findIndex(counts);
  if (x0 < 0 || y0 < 0) return null;
  const x1 = cols.findLastIndex(counts);
  const y1 = rows.findLastIndex(counts);
  return { paper, bbox: [x0, y0, x1 - x0 + 1, y1 - y0 + 1] };
}

// The widest bare band beside the subject, in the picture's own pixels.
function paperStrip(w: number, h: number, [bx, by, bw, bh]: Rect): Rect | null {
  const right = bx + bw + MARGIN;
  const below = by + bh + MARGIN;
  const strips: Rect[] = [
    [0, 0, bx - MARGIN, h],
    [right, 0, w - right, h],
    [0, 0, w, by - MARGIN],
    [0, below, w, h - below],
  ];
  let best: Rect | null = null;
  for (const s of strips) if (s[2] > 0 && s[3] > 0 && (best === null || s[2] * s[3] > best[2] * best[3])) best = s;
  return best;
}

// Mirrored tiles carry the real grain of the paper across the box with no seam between them.
function tileMirrored(g: SKRSContext2D, tile: Canvas, w: number, h: number): void {
  for (let ty = 0, j = 0; ty < h; ty += tile.height, j++) {
    for (let tx = 0, i = 0; tx < w; tx += tile.width, i++) {
      g.save();
      g.translate(tx + (i % 2 ? tile.width : 0), ty + (j % 2 ? tile.height : 0));
      g.scale(i % 2 ? -1 : 1, j % 2 ? -1 : 1);
      g.drawImage(tile, 0, 0);
      g.restore();
    }
  }
}

// 0 at each end of a line `n` pixels long, rising smoothly to 1 over `near` and `far` pixels in.
function ramp(n: number, near: number, far: number): Float32Array {
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = Math.min(1, near > 0 ? (i + 0.5) / near : 1, far > 0 ? (n - i - 0.5) / far : 1);
    r[i] = t * t * (3 - 2 * t);
  }
  return r;
}

// Soft edges, so no line shows where the picture meets the extended paper. Each band ends where the subject begins,
// so the subject keeps its full ink however close to the edge it was printed.
function feathered(image: Image, w: number, h: number, [left, top, right, bottom]: Bands): Canvas {
  const layer = createCanvas(w, h);
  const l = layer.getContext('2d');
  l.drawImage(image, 0, 0, w, h);
  const cols = ramp(w, left, right);
  const rows = ramp(h, top, bottom);
  const px = l.getImageData(0, 0, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4 + 3;
      px.data[i] = Math.round((px.data[i] ?? 0) * (rows[y] ?? 0) * (cols[x] ?? 0));
    }
  }
  l.putImageData(px, 0, 0);
  return layer;
}

/**
 * Redraws a still at its box's size with the subject shrunk into `fit` (frame pixels, inside `rect`), centred, never
 * enlarged, on the picture's own paper. Meant for prints on even paper, which a generator draws past its layout box.
 */
export async function fitStill(image: Image, rect: Rect, fit: Rect): Promise<Fitted> {
  const { width, height } = image;
  const src = createCanvas(width, height).getContext('2d');
  src.drawImage(image, 0, 0);
  const subject = measureSubject({ data: src.getImageData(0, 0, width, height).data, width, height });
  if (subject === null) return { kind: 'no-subject' };
  const [bx, by, bw, bh] = subject.bbox;
  const [rx, ry, rw, rh] = rect;
  const [fx, fy, fw, fh] = fit;
  const f = Math.min(fw / bw, fh / bh, 1);

  const strip = paperStrip(width, height, subject.bbox);
  if (strip === null) return { kind: 'no-paper' };
  const [sx, sy, sw, sh] = [strip[0] + EDGE, strip[1] + EDGE, strip[2] - 2 * EDGE, strip[3] - 2 * EDGE];
  if (sw < MIN_TILE || sh < MIN_TILE) return { kind: 'no-paper' };
  const tileW = Math.floor(sw * f);
  const tileH = Math.floor(sh * f);
  if (tileW < MIN_TILE || tileH < MIN_TILE) return { kind: 'too-small' };
  const tile = createCanvas(tileW, tileH);
  tile.getContext('2d').drawImage(image, sx, sy, sw, sh, 0, 0, tileW, tileH);

  const out = createCanvas(rw, rh);
  const g = out.getContext('2d');
  tileMirrored(g, tile, rw, rh);
  const ox = Math.round(fx - rx + fw / 2 - (bx + bw / 2) * f);
  const oy = Math.round(fy - ry + fh / 2 - (by + bh / 2) * f);
  const band = (margin: number): number => Math.min(FEATHER, Math.floor(margin * f));
  const bands: Bands = [band(bx), band(by), band(width - bx - bw), band(height - by - bh)];
  g.drawImage(feathered(image, Math.round(width * f), Math.round(height * f), bands), ox, oy);
  return { kind: 'fitted', image: await loadImage(await out.encode('png')) };
}
