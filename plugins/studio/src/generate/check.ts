import { type ProbeInfo, probe } from '../make/index.ts';
import { DURATION_TOLERANCE_MS } from './limits.ts';
import type { Expect } from './provider.ts';

// For a model whose output ratio follows the first frame: the keyframe's size and the rows sharing the sent params.
export type Follows = { keyframe: readonly [number, number]; rows: readonly (readonly [number, number])[] } | null;
type Verdict = { ok: true } | { ok: false; reason: string };

// The format_name ffprobe 8 reports for png, jpeg and webp files (confirmed on ffmpeg- and cwebp-made files).
const IMAGE_FORMATS: ReadonlySet<string> = new Set(['png_pipe', 'jpeg_pipe', 'webp_pipe']);
// ffprobe names one demuxer for the whole ISO family, e.g. "mov,mp4,m4a,3gp,3g2,mj2".
const VIDEO_FORMATS: ReadonlySet<string> = new Set(['mp4', 'mov']);
// The provider rounds its own sizes, so a follower's output may sit a pixel or two off the ratio.
const SLACK_PX = 2;

function formatProblem(info: ProbeInfo, e: Expect): string | null {
  if (!info.hasVideo) return 'the file has no picture';
  if (e.output === 'image')
    return IMAGE_FORMATS.has(info.format) ? null : `format ${info.format} is not png, jpeg or webp`;
  return info.format.split(',').some((f) => VIDEO_FORMATS.has(f)) ? null : `format ${info.format} is not mp4 or mov`;
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= SLACK_PX;

function fitsFollower(w: number, h: number, f: NonNullable<Follows>): boolean {
  const [kw, kh] = f.keyframe;
  return f.rows.some(([rw, rh]) => near(w, rw) && near(h, rh)) || near(h, Math.round((w * kh) / kw));
}

function sizeProblem(info: ProbeInfo, e: Expect, follows: Follows): string | null {
  const { width: w, height: h } = info;
  if (follows === null) return w === e.w && h === e.h ? null : `size ${w}x${h}, expected ${e.w}x${e.h}`;
  if (fitsFollower(w, h, follows)) return null;
  const [kw, kh] = follows.keyframe;
  return `size ${w}x${h} matches no row of its params and not the keyframe ratio ${kw}x${kh}`;
}

// The picture, not the container: models' sound runs up to ~120 ms past the picture, and the container takes the longer one.
function videoProblem(info: ProbeInfo, e: Expect): string | null {
  const ms = info.videoDurationMs;
  const off = ms === null || e.durationMs === null || Math.abs(ms - e.durationMs) > DURATION_TOLERANCE_MS;
  if (off)
    return `picture length ${ms ?? 'unknown'} ms, expected ${e.durationMs ?? 'unknown'} ± ${DURATION_TOLERANCE_MS} ms`;
  if (info.hasAudio === e.audio) return null;
  return e.audio ? 'expected an audio track, found none' : 'expected no audio track, found one';
}

export async function checkRaw(file: string, e: Expect, follows: Follows = null): Promise<Verdict> {
  let info: ProbeInfo;
  try {
    info = await probe(file);
  } catch (err) {
    return { ok: false, reason: `ffprobe could not read the file: ${err instanceof Error ? err.message : 'unknown'}` };
  }
  const problem =
    formatProblem(info, e) ?? sizeProblem(info, e, follows) ?? (e.output === 'video' ? videoProblem(info, e) : null);
  return problem === null ? { ok: true } : { ok: false, reason: problem };
}
