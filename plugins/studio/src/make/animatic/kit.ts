import { type Canvas, createCanvas, type SKRSContext2D } from '@napi-rs/canvas';

type Pt = readonly [number, number];
type Easing = (k: number) => number;
type Size = { w: number; h: number };
type Place = { x: number; y: number; scale: number };

const TAU = Math.PI * 2;
const INK = '#2A2622';

const clamp = (x: number): number => Math.max(0, Math.min(1, x));
const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;

const BACK = 1.70158;
const ease = {
  lin: (k: number): number => k,
  io: (k: number): number => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2),
  out3: (k: number): number => 1 - (1 - k) ** 3,
  // Overshoots past 1 and settles back, for things that pop into place.
  back: (k: number): number => 1 + (BACK + 1) * (k - 1) ** 3 + BACK * (k - 1) ** 2,
} as const;

function P(t: number, t0: number, d: number, easing: Easing = ease.io): number {
  // A beat without a duration is a step rather than a division by zero.
  if (d <= 0) return t < t0 ? 0 : 1;
  return easing(clamp((t - t0) / d));
}

function hash(i: number, seed: number): number {
  const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
  const f = x - Math.floor(x);
  // A tiny negative x makes x - floor(x) round up to exactly 1.
  return f < 1 ? f : 0;
}

type SketchOptions = {
  closed?: boolean;
  fill?: string;
  stroke?: string | null;
  w?: number;
  seed?: number;
  jit?: number;
};

// A fixed per-point jitter keyed by the seed makes lines look hand drawn yet identical on every frame.
function sketch(g: SKRSContext2D, pts: readonly Pt[], o: SketchOptions = {}): void {
  const { closed = true, fill, stroke = INK, w = 5, seed = 1, jit = 3 } = o;
  const [first, ...rest] = pts.map(
    ([x, y], i): Pt => [x + (hash(i, seed) - 0.5) * jit, y + (hash(i, seed + 9) - 0.5) * jit],
  );
  if (first === undefined) throw new Error('kit.sketch needs at least one point');
  g.beginPath();
  g.moveTo(first[0], first[1]);
  let prev = first;
  for (const p of rest) {
    g.quadraticCurveTo(prev[0], prev[1], (prev[0] + p[0]) / 2, (prev[1] + p[1]) / 2);
    prev = p;
  }
  g.lineTo(prev[0], prev[1]);
  if (closed) g.closePath();
  if (fill) {
    g.fillStyle = fill;
    g.fill();
  }
  if (stroke) {
    g.strokeStyle = stroke;
    g.lineWidth = w;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.stroke();
  }
}

const ellipsePts = (cx: number, cy: number, rx: number, ry: number, n = 28, a0 = 0, a1 = TAU): [number, number][] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = lerp(a0, a1, i / n);
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
  });

// sketch rounds each corner from edge midpoint to edge midpoint, so a large shape needs points along its edges to
// keep its corners tight. Starting and ending in the middle of the first edge leaves every corner rounded alike.
function dense(pts: readonly Pt[], step = 30): Pt[] {
  if (!(step > 0 && Number.isFinite(step))) throw new Error('kit.dense needs a finite step above 0');
  const [a, b] = pts;
  if (a === undefined || b === undefined) return pts.map((p): Pt => [p[0], p[1]]);
  const loop: Pt[] = [[(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], ...pts.slice(1), a];
  const out: Pt[] = [];
  for (const [i, [x0, y0]] of loop.entries()) {
    const next = loop[(i + 1) % loop.length];
    if (next === undefined) continue;
    const [x1, y1] = next;
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let j = 0; j < n; j++) out.push([x0 + ((x1 - x0) * j) / n, y0 + ((y1 - y0) * j) / n]);
  }
  return out;
}

const unit = (x: number, y: number): Pt => {
  const len = Math.hypot(x, y);
  return len === 0 ? [0, 0] : [x / len, y / len];
};

const LIMB_LINE = 6;

function limb(
  g: SKRSContext2D,
  from: Pt,
  joint: Pt,
  to: Pt,
  o: { w: number; fill: string; stroke?: string; seed?: number },
): void {
  const n1 = unit(from[1] - joint[1], joint[0] - from[0]);
  const n2 = unit(joint[1] - to[1], to[0] - joint[0]);
  const nj = unit(n1[0] + n2[0], n1[1] + n2[1]);
  const side = (p: Pt, n: Pt, k: number): Pt => [p[0] + n[0] * k, p[1] + n[1] * k];
  const h = o.w / 2;
  const outline = [
    side(from, n1, h),
    side(joint, nj, h),
    side(to, n2, h),
    side(to, n2, -h),
    side(joint, nj, -h),
    side(from, n1, -h),
  ];
  sketch(g, outline, { fill: o.fill, stroke: o.stroke ?? INK, w: LIMB_LINE, seed: o.seed ?? 1 });
}

function blink(t: number, atMs: readonly number[], durMs = 140): number {
  const half = durMs / 2;
  return atMs.reduce((closed, at) => Math.max(closed, 1 - clamp(Math.abs(t - at - half) / half)), 0);
}

function handheld(g: SKRSContext2D, t: number, box: Size, amount = 1): void {
  const s = t / 1000;
  const wave = (hz: number, phase = 0): number => Math.sin(s * TAU * hz + phase);
  // A slow drift plus a small fast tremor, as from a phone held in one hand.
  const dx = (wave(0.45) * 10 + wave(1.7, 1) * 4) * amount;
  const dy = (wave(0.35, 2) * 8 + wave(2.1) * 3) * amount;
  g.translate(box.w / 2 + dx, box.h / 2 + dy);
  g.rotate(wave(0.3) * 0.006 * amount);
  g.translate(-box.w / 2, -box.h / 2);
}

// The margin keeps the box covered while handheld shakes it and the blur softens its edges.
const BACKGROUND_MARGIN = 100;
const backgrounds = new Map<string, Canvas>();

function softImage(box: Size, draw: (g: SKRSContext2D) => void, blurPx: number): Canvas {
  const sharp = createCanvas(box.w + 2 * BACKGROUND_MARGIN, box.h + 2 * BACKGROUND_MARGIN);
  const sg = sharp.getContext('2d');
  sg.translate(BACKGROUND_MARGIN, BACKGROUND_MARGIN);
  draw(sg);
  const soft = createCanvas(sharp.width, sharp.height);
  const bg = soft.getContext('2d');
  bg.filter = `blur(${blurPx}px)`;
  bg.drawImage(sharp, 0, 0);
  return soft;
}

// Blurring every frame is slow and the background does not move, so it is drawn once per key, size and blur.
function background(g: SKRSContext2D, key: string, box: Size, draw: (g: SKRSContext2D) => void, blurPx = 7): void {
  const id = JSON.stringify([key, box.w, box.h, blurPx]);
  let image = backgrounds.get(id);
  if (image === undefined) {
    image = softImage(box, draw, blurPx);
    backgrounds.set(id, image);
  }
  g.drawImage(image, -BACKGROUND_MARGIN, -BACKGROUND_MARGIN);
}

const HEX = /^#[0-9a-f]{6}$/i;

// Shadows and outlines come from the look's own colors, so those must be plain hex to be mixed.
function shade(color: string, k: number): string {
  if (!HEX.test(color)) throw new Error(`kit.person takes #rrggbb colors, got "${color}"`);
  const n = Number.parseInt(color.slice(1), 16);
  const target = k < 0 ? 0 : 255;
  const ch = (bits: number): number => Math.round(lerp((n >> bits) & 255, target, Math.abs(k)));
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

type Look = { skin: string; hair: string; hairLength: 'short' | 'long'; top: string; jacket: string | null };
// `tilt` is radians, so a scene can add its own nod to a beat's tilt.
type Pose = { blink: number; mouth: number; smile: number; tilt: number };

type Coat = { fill: string; line: string; lapel: string; edge: string };
type Palette = {
  skin: string;
  skinShade: string;
  nose: string;
  hair: string;
  hairLine: string;
  hairStrand: string;
  brow: string;
  top: string;
  topLine: string;
  jacket: Coat | null;
};

function palette(look: Look): Palette {
  const j = look.jacket;
  return {
    skin: look.skin,
    skinShade: shade(look.skin, -0.1),
    nose: shade(look.skin, -0.28),
    hair: look.hair,
    hairLine: shade(look.hair, -0.42),
    hairStrand: shade(look.hair, -0.14),
    brow: shade(look.hair, -0.34),
    top: look.top,
    topLine: shade(look.top, -0.6),
    jacket: j === null ? null : { fill: j, line: shade(j, -0.55), lapel: shade(j, 0.1), edge: shade(j, 0.35) },
  };
}

// Person and cup are drawn in their own fixed coordinates and moved to `at`; FACE is the person's face center, the
// point that lands on `at`.
const FACE: Pt = [540, 780];
const NECK_BASE: Pt = [540, 1000];
// sketch leaves only a closed shape's first and last points sharp, so the hem's two corners go at the ends.
const TORSO: Pt[] = [
  [-20, 1980],
  [40, 1100],
  [300, 990],
  [470, 1000],
  [610, 1000],
  [780, 990],
  [1040, 1100],
  [1100, 1980],
];

function torso(g: SKRSContext2D, c: Palette): void {
  const jacket = c.jacket;
  if (jacket === null) {
    sketch(g, TORSO, { fill: c.top, w: 6, stroke: c.topLine, seed: 70 });
    sketch(
      g,
      [
        [470, 1000],
        [540, 1045],
        [610, 1000],
      ],
      { closed: false, w: 4, stroke: c.topLine, seed: 71 },
    );
    return;
  }
  sketch(g, TORSO, { fill: jacket.fill, w: 6, stroke: jacket.line, seed: 70 });
  sketch(
    g,
    dense([
      [440, 1980],
      [470, 1000],
      [610, 1000],
      [640, 1980],
    ]),
    { fill: c.top, w: 4, stroke: c.topLine, seed: 71 },
  );
  sketch(
    g,
    [
      [300, 990],
      [470, 1000],
      [430, 1180],
      [330, 1120],
    ],
    { fill: jacket.lapel, w: 5, stroke: jacket.line, seed: 72 },
  );
  sketch(
    g,
    [
      [780, 990],
      [610, 1000],
      [650, 1180],
      [750, 1120],
    ],
    { fill: jacket.lapel, w: 5, stroke: jacket.line, seed: 73 },
  );
  sketch(
    g,
    [
      [440, 1180],
      [425, 1980],
    ],
    { closed: false, w: 3, stroke: jacket.edge, seed: 74 },
  );
  sketch(
    g,
    [
      [640, 1180],
      [655, 1980],
    ],
    { closed: false, w: 3, stroke: jacket.edge, seed: 75 },
  );
}

// Behind the head and resting on the shoulders, one silhouette is enough for long hair to read from the front.
// It starts and ends behind the neck so that every visible corner is rounded alike.
const LONG_HAIR: Pt[] = [
  [540, 940],
  [454, 940],
  [416, 1040],
  [350, 1110],
  [268, 1080],
  [290, 940],
  [304, 780],
  [318, 600],
  [390, 492],
  [540, 462],
  [690, 492],
  [762, 600],
  [776, 780],
  [790, 940],
  [812, 1080],
  [730, 1110],
  [664, 1040],
  [626, 940],
  [540, 940],
];

function hairCap(g: SKRSContext2D, c: Palette): void {
  const fringe = Array.from(
    { length: 13 },
    (_, i): Pt => [lerp(372, 708, i / 12), 660 + (i % 2 === 1 ? 40 : 0) + Math.sin(i * 1.7) * 14],
  ).reverse();
  const cap: Pt[] = [
    [352, 760],
    [356, 600],
    [420, 500],
    [540, 470],
    [660, 495],
    [724, 590],
    [728, 760],
    [700, 690],
    ...fringe,
    [380, 690],
  ];
  sketch(g, cap, { fill: c.hair, stroke: c.hairLine, w: 5, seed: 55 });
  for (let i = 0; i < 7; i++) {
    const x = 400 + i * 48;
    sketch(
      g,
      [
        [x, 520],
        [x + 18, 590],
        [x + 6, 650],
      ],
      { closed: false, w: 3, stroke: c.hairStrand, seed: 60 + i },
    );
  }
}

// Below this the voice is too quiet for an open mouth to read as speech.
const MOUTH_OPEN_FROM = 0.08;

function features(g: SKRSContext2D, c: Palette, pose: Pose): void {
  const smile = clamp(pose.smile);
  const eyeH = lerp(13, 1.5, clamp(pose.blink)) * (1 - smile * 0.25);
  for (const [x, seed] of [
    [470, 50],
    [610, 51],
  ] as const) {
    g.fillStyle = INK;
    g.beginPath();
    g.ellipse(x, 765, 17, eyeH, 0, 0, TAU);
    g.fill();
    sketch(
      g,
      [
        [x - 34, 718],
        [x, 708],
        [x + 32, 716],
      ],
      { closed: false, w: 6, stroke: c.brow, seed },
    );
  }
  sketch(
    g,
    [
      [545, 790],
      [535, 850],
      [555, 858],
    ],
    { closed: false, w: 4, stroke: c.nose, seed: 52 },
  );
  const open = clamp(pose.mouth);
  if (open > MOUTH_OPEN_FROM) {
    const rx = lerp(26, 34, open);
    const ry = lerp(4, 22, open);
    g.fillStyle = '#7A3B36';
    g.beginPath();
    g.ellipse(540, 895, rx, ry, 0, 0, TAU);
    g.fill();
    sketch(g, ellipsePts(540, 895, rx, ry, 16), { stroke: '#5A2A26', w: 3, seed: 53 });
    return;
  }
  const cornerUp = lerp(4, 16, smile);
  sketch(
    g,
    [
      [500, 892 - cornerUp],
      [540, 900],
      [580, 892 - cornerUp],
    ],
    { closed: false, w: 5, stroke: '#9A5A52', seed: 54 },
  );
}

function head(g: SKRSContext2D, c: Palette, look: Look, pose: Pose): void {
  if (look.hairLength === 'long') sketch(g, LONG_HAIR, { fill: c.hair, stroke: c.hairLine, w: 5, seed: 57 });
  // The sharp ends sit at the base of the neck; the rounded top corners hide behind the jaw.
  sketch(
    g,
    [
      [470, 1010],
      [480, 900],
      [600, 900],
      [610, 1010],
    ],
    { fill: c.skinShade, w: 4, seed: 40 },
  );
  sketch(g, ellipsePts(368, 780, 28, 48), { fill: c.skin, w: 4, seed: 41 });
  sketch(g, ellipsePts(712, 780, 28, 48), { fill: c.skin, w: 4, seed: 42 });
  const face: Pt[] = [
    ...ellipsePts(540, 760, 172, 150, 16, Math.PI, TAU),
    [712, 800],
    [660, 900],
    [540, 950],
    [420, 900],
    [368, 800],
  ];
  sketch(g, face, { fill: c.skin, w: 5, seed: 43 });
  // The light is on the left, so the right cheek gets a soft shadow.
  g.fillStyle = 'rgba(200, 140, 110, 0.10)';
  g.beginPath();
  g.ellipse(660, 800, 45, 120, 0, 0, TAU);
  g.fill();
  features(g, c, pose);
  hairCap(g, c);
}

function person(g: SKRSContext2D, at: Place, look: Look, pose: Pose): void {
  const c = palette(look);
  g.save();
  g.translate(at.x, at.y);
  g.scale(at.scale, at.scale);
  g.translate(-FACE[0], -FACE[1]);
  torso(g, c);
  g.translate(NECK_BASE[0], NECK_BASE[1]);
  g.rotate(pose.tilt);
  g.translate(-NECK_BASE[0], -NECK_BASE[1]);
  head(g, c, look, pose);
  g.restore();
}

const CUP_WHITE = '#FAFAF8';
const CUP_LINE = '#4A4540';

function cup(g: SKRSContext2D, at: Place, t: number, o: { steam?: boolean } = {}): void {
  g.save();
  g.translate(at.x, at.y);
  g.scale(at.scale, at.scale);
  if (o.steam ?? true) {
    const s = t / 1000;
    const alpha = g.globalAlpha;
    for (let k = 0; k < 3; k++) {
      const phase = s * 1.6 + k * 2.1;
      const x0 = -40 + k * 40;
      const pts = Array.from({ length: 7 }, (_, i): Pt => [x0 + Math.sin(phase + i * 0.9) * 12, -110 - i * 26]);
      g.globalAlpha = alpha * (0.45 - k * 0.08);
      sketch(g, pts, { closed: false, w: 4, stroke: '#FFFFFF', seed: 91 + k, jit: 1 });
    }
    g.globalAlpha = alpha;
  }
  // No hand covers the handle's edge, so the white handle needs its own outline.
  const handle = ellipsePts(108, -10, 38, 42, 12, -Math.PI / 2, Math.PI / 2);
  sketch(g, handle, { closed: false, w: 20, stroke: CUP_LINE, seed: 97, jit: 1 });
  sketch(g, handle, { closed: false, w: 12, stroke: CUP_WHITE, seed: 97, jit: 1 });
  sketch(
    g,
    dense([
      [-105, -80],
      [105, -80],
      [85, 70],
      [-85, 70],
    ]),
    { fill: CUP_WHITE, w: 5, stroke: CUP_LINE, seed: 95 },
  );
  sketch(g, ellipsePts(0, -80, 105, 24), { fill: '#3A2418', w: 4, stroke: CUP_LINE, seed: 96 });
  g.restore();
}

export const kit = {
  P,
  ease,
  lerp,
  clamp,
  hash,
  sketch,
  dense,
  ellipsePts,
  limb,
  blink,
  handheld,
  background,
  person,
  cup,
} as const;

export type Kit = typeof kit;
