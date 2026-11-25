import type { SKRSContext2D } from '@napi-rs/canvas';
import { METHOD_COLORS, PREVIEW_GROUND } from '../draw/scene.ts';

export type StripItem = { kind: 'line' | 'beat'; label: string; startMs: number; endMs: number };
export type Strip = { totalMs: number; cutStartsMs: number[]; lanes: StripItem[][] };

const HEADER_PX = 64;
const LANE_PX = 48;
const BAR_PAD_PX = 4;
// Low enough that the playhead dot clears the time text centred at a quarter of the header.
const AXIS_Y = 50;
// The preview shows the strip at half size, so this reads as 14 px in the video.
const TEXT_PX = 28;
const FONT = `${TEXT_PX}px "pretendard-bold"`;
const WHITE = '#ffffff';
const DIM = 'rgba(255, 255, 255, 0.45)';
const LINE_NAME = 'line';
// A label needs about this share of the whole timeline, so even an instant beat is not drawn over its neighbour.
const MIN_SPAN_SHARE = 1 / 8;

const KIND_ORDER: readonly StripItem['kind'][] = ['line', 'beat'];

// Lines come first so the spoken track always sits right under the axis.
export function planStrip(totalMs: number, cutStartsMs: number[], items: readonly StripItem[]): Strip {
  const room = totalMs * MIN_SPAN_SHARE;
  const lanes: StripItem[][] = [];
  for (const kind of KIND_ORDER) {
    const laneEnds: number[] = [];
    const first = lanes.length;
    for (const item of items.filter((i) => i.kind === kind).toSorted((a, b) => a.startMs - b.startMs)) {
      let lane = laneEnds.findIndex((end) => item.startMs >= end);
      if (lane < 0) {
        lane = laneEnds.length;
        lanes.push([]);
      }
      lanes[first + lane]?.push(item);
      laneEnds[lane] = Math.max(item.endMs, item.startMs + room);
    }
  }
  return { totalMs, cutStartsMs, lanes };
}

export const stripHeightPx = (strip: Strip): number => HEADER_PX + LANE_PX * strip.lanes.length;

function drawLane(g: SKRSContext2D, lane: readonly StripItem[], top: number, xOf: (ms: number) => number): void {
  for (const item of lane) {
    const x = xOf(item.startMs);
    const w = Math.max(2, xOf(item.endMs) - x);
    g.fillStyle = item.kind === 'line' ? METHOD_COLORS.capture : METHOD_COLORS.draw;
    g.fillRect(x, top + BAR_PAD_PX, w, LANE_PX - 2 * BAR_PAD_PX);
  }
}

export function drawStrip(g: SKRSContext2D, strip: Strip, tMs: number, widthPx: number): void {
  const { totalMs } = strip;
  const height = stripHeightPx(strip);
  const xOf = (ms: number): number => (Math.min(Math.max(ms, 0), totalMs) / totalMs) * widthPx;
  g.save();
  g.fillStyle = PREVIEW_GROUND;
  g.fillRect(0, 0, widthPx, height);

  g.fillStyle = DIM;
  g.fillRect(0, AXIS_Y, widthPx, 1);
  for (const start of strip.cutStartsMs) g.fillRect(xOf(start), HEADER_PX / 2, 1, HEADER_PX / 2);

  g.font = FONT;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  strip.lanes.forEach((lane, i) => {
    const top = HEADER_PX + LANE_PX * i;
    drawLane(g, lane, top, xOf);
    for (const item of lane) {
      const x = xOf(item.startMs);
      const room = Math.max(xOf(item.endMs), xOf(item.startMs + totalMs * MIN_SPAN_SHARE)) - x;
      g.fillStyle = WHITE;
      g.fillText(
        item.kind === 'line' ? LINE_NAME : item.label,
        x + BAR_PAD_PX,
        top + LANE_PX / 2,
        Math.max(1, room - BAR_PAD_PX),
      );
    }
  });

  const x = xOf(tMs);
  g.fillStyle = WHITE;
  g.fillRect(x - 1, 0, 2, height);
  g.beginPath();
  g.arc(x, AXIS_Y, 5, 0, Math.PI * 2);
  g.fill();
  const text = `${(tMs / 1000).toFixed(1)}s`;
  const onLeft = x + 8 + g.measureText(text).width > widthPx;
  g.textAlign = onLeft ? 'right' : 'left';
  g.fillText(text, onLeft ? x - 8 : x + 8, HEADER_PX / 4);
  g.restore();
}
