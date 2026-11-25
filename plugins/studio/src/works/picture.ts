import { type FileHandle, open } from 'node:fs/promises';

export type PictureFormat = 'png' | 'jpeg' | 'webp';
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function formatOf(head: Buffer): PictureFormat | null {
  if (head.subarray(0, 8).equals(PNG_HEAD)) return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

async function headOf(abs: string): Promise<Buffer> {
  const head = Buffer.alloc(12);
  const file = await open(abs, 'r');
  try {
    await file.read(head, 0, head.length, 0);
  } finally {
    await file.close();
  }
  return head;
}

export async function pictureFormat(abs: string): Promise<PictureFormat | null> {
  return formatOf(await headOf(abs));
}

export type StoredSize = { kind: 'size'; size: readonly [number, number] } | { kind: 'unreadable' };

const UNREADABLE: StoredSize = { kind: 'unreadable' };
const HEADER_BYTES = 30;
const PNG_MAX_SIDE = 0x7fffffff;

// A PNG's size field ends at byte 24, a VP8L's at 25, a VP8 and a VP8X at 30.
const PNG_END = 24;
const VP8L_END = 25;

function sized(w: number, h: number): StoredSize {
  return w > 0 && h > 0 ? { kind: 'size', size: [w, h] } : UNREADABLE;
}

function pngSize(head: Buffer, got: number): StoredSize {
  if (got < PNG_END || head.toString('latin1', 12, 16) !== 'IHDR') return UNREADABLE;
  const w = head.readUInt32BE(16);
  const h = head.readUInt32BE(20);
  return w > PNG_MAX_SIDE || h > PNG_MAX_SIDE ? UNREADABLE : sized(w, h);
}

// The animation flag in a VP8X header. ffprobe finds no picture in an animated webp and reports 0x0.
const VP8X_ANIMATED = 0x02;

// The 14-bit sizes: the top two bits of a VP8 size are a scale hint, not part of it.
function webpSize(head: Buffer, got: number): StoredSize {
  switch (head.toString('latin1', 12, 16)) {
    case 'VP8 ':
      if (got < HEADER_BYTES || head[23] !== 0x9d || head[24] !== 0x01 || head[25] !== 0x2a) return UNREADABLE;
      return sized(head.readUInt16LE(26) & 0x3fff, head.readUInt16LE(28) & 0x3fff);
    case 'VP8L': {
      if (got < VP8L_END || head[20] !== 0x2f) return UNREADABLE;
      const bits = head.readUInt32LE(21);
      return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    case 'VP8X':
      if (got < HEADER_BYTES || ((head[20] as number) & VP8X_ANIMATED) !== 0) return UNREADABLE;
      return sized(head.readUIntLE(24, 3) + 1, head.readUIntLE(27, 3) + 1);
    default:
      return UNREADABLE;
  }
}

async function readAt(file: FileHandle, position: number, length: number): Promise<Buffer | null> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await file.read(buf, 0, length, position);
  return bytesRead === length ? buf : null;
}

// 0xc0-0xcf are SOF markers, which hold the frame size, except DHT (c4), JPG (c8) and DAC (cc): ordinary segments
// with a length, skipped like any other.
const NO_SIZE_MARKERS = new Set([0xc4, 0xc8, 0xcc]);

function isSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && !NO_SIZE_MARKERS.has(marker);
}

// Segments are skipped by their length with positional reads, so a large metadata segment is never loaded.
async function jpegSize(file: FileHandle): Promise<StoredSize> {
  let at = 2;
  for (;;) {
    const pair = await readAt(file, at, 2);
    if (pair === null || pair[0] !== 0xff) return UNREADABLE;
    const marker = pair[1] as number;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (isSof(marker)) {
      const sof = await readAt(file, at + 2, 7);
      return sof === null ? UNREADABLE : sized(sof.readUInt16BE(5), sof.readUInt16BE(3));
    }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0xda) return UNREADABLE;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    const length = await readAt(file, at + 2, 2);
    if (length === null || length.readUInt16BE(0) < 2) return UNREADABLE;
    at += 2 + length.readUInt16BE(0);
  }
}

// The width and height a file stores, which is what ffprobe reports. A viewer may turn a JPEG by its EXIF mark; this
// does not, so the brief check and the generate check read one size. Stricter than ffprobe on purpose: a header it
// cannot follow is unreadable, never a guess. A file that cannot be opened throws.
export async function storedSize(abs: string): Promise<StoredSize> {
  const file = await open(abs, 'r');
  try {
    const head = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await file.read(head, 0, HEADER_BYTES, 0);
    switch (formatOf(head)) {
      case 'png':
        return pngSize(head, bytesRead);
      case 'webp':
        return webpSize(head, bytesRead);
      case 'jpeg':
        return await jpegSize(file);
      case null:
        return UNREADABLE;
    }
  } finally {
    await file.close();
  }
}

// Same ratio means within a pixel of width at the smaller picture's scale, where rounding happens. In BigInt: a png
// side goes up to 2^31-1, and the product of two such sides is past what a float holds exactly.
export function sameRatio(a: readonly [number, number], b: readonly [number, number]): boolean {
  const off = BigInt(b[0]) * BigInt(a[1]) - BigInt(a[0]) * BigInt(b[1]);
  return (off < 0n ? -off : off) <= BigInt(Math.max(a[1], b[1]));
}
