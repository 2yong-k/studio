import type { SKRSContext2D } from '@napi-rs/canvas';
import type { Draw, Rect } from '../../works/index.ts';

const STROKE_PX = 6;
const ROUND_RATIO = 0.15;
const ARROW_HEAD_MAX_PX = 36;

// A line or arrow runs corner to corner of its rect, so the rect's aspect sets its slope.
function drawLine(ctx: SKRSContext2D, [x, y, w, h]: Rect, withHead: boolean): void {
  const x2 = x + w;
  const y2 = y + h;
  ctx.lineWidth = STROKE_PX;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  if (!withHead) return;
  const angle = Math.atan2(h, w);
  const head = Math.min(ARROW_HEAD_MAX_PX, Math.hypot(w, h) * 0.3);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
  ctx.stroke();
}

export function drawShape(ctx: SKRSContext2D, shape: NonNullable<Draw['shape']>, rect: Rect, color: string): void {
  const [x, y, w, h] = rect;
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  switch (shape) {
    case 'rect':
      ctx.fillRect(x, y, w, h);
      break;
    case 'roundRect':
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, Math.min(w, h) * ROUND_RATIO);
      ctx.fill();
      break;
    case 'circle':
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'line':
      drawLine(ctx, rect, false);
      break;
    case 'arrow':
      drawLine(ctx, rect, true);
      break;
    default: {
      const never: never = shape;
      throw new Error(`unknown shape: ${String(never)}`);
    }
  }
  ctx.restore();
}
