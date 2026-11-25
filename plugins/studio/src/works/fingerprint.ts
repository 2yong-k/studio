import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { type JsonValue, StudioError } from '../errors.ts';
import {
  type Brief,
  type BriefCtx,
  briefPath,
  type GenerateImage,
  type GenerateVideo,
  keyframeOwner,
} from './brief.ts';
import { sha256File } from './files.ts';
import { type Rect, type ResolvedSize, resolveSize } from './models.ts';
import { acceptedOf, attempts } from './spend.ts';

export type FingerprintInput = {
  model: string;
  prompt: string;
  size: [number, number];
  durationMs: number | null;
  refShas: string[];
  layoutRefSha: string | null;
  keyframeSha: string | null;
  // Absent, not null, without a last frame: the hash of every earlier input stays what it was.
  lastFrameSha?: string;
};

type Generated = GenerateImage | GenerateVideo;

// Keys are unique within an object, so the comparator never sees a tie.
function sortKeys(v: JsonValue): JsonValue {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v === null || typeof v !== 'object') return v;
  const entries = Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1));
  return Object.fromEntries(entries.map(([k, x]) => [k, sortKeys(x)]));
}

// Sorted keys make the hash depend on the values alone, not on the order the object was built in.
export function inputHash(x: FingerprintInput): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(sortKeys(x)))
    .digest('hex')}`;
}

// The brief is expected to have passed loadBrief, so a miss here is a caller bug rather than a brief problem.
function generatedAt(brief: Brief, elementId: string): { el: Generated; index: number } {
  const index = brief.elements.findIndex((e) => e.id === elementId);
  const el = brief.elements[index];
  if (el === undefined || el.method !== 'generate') {
    throw new StudioError('UNEXPECTED', `${elementId} is not a generated element`, { element: elementId });
  }
  return { el, index };
}

// A keyframe has no box of its own; it is made at the size of the video it opens.
function rectOf(brief: Brief, el: Generated): Rect {
  const opensVideo = brief.elements.some((e) => e.method === 'generate' && e.output === 'video' && e.from === el.id);
  if (el.output === 'image' && opensVideo) return keyframeOwner(brief, el.id).box.rect;
  const boxes = brief.kind === 'image' ? brief.layout : brief.cuts.flatMap((c) => c.layout);
  const box = boxes.find((b) => b.element === el.id);
  if (box === undefined) throw new StudioError('UNEXPECTED', `${el.id} has no box to size it from`, { element: el.id });
  return box.rect;
}

// Shared by the fingerprint and the estimate so both always size an element the same way.
export function elementSize(ctx: BriefCtx, brief: Brief, elementId: string): ResolvedSize {
  const { el } = generatedAt(brief, elementId);
  const model = ctx.models.get(el.model);
  const size = model === undefined ? null : resolveSize(model, rectOf(brief, el), el.size);
  if (size === null) {
    throw new StudioError('UNEXPECTED', `${el.id} has no size in model ${el.model}`, {
      element: el.id,
      model: el.model,
    });
  }
  return size;
}

function refShas(ctx: BriefCtx, el: Generated): Promise<string[]> {
  const refs = el.output === 'image' ? (el.refs ?? []) : [];
  return Promise.all(refs.map((rel) => sha256File(briefPath(ctx, rel))));
}

async function layoutRefSha(ctx: BriefCtx, el: Generated, index: number): Promise<string | null> {
  if (el.output !== 'image' || el.layoutRef !== true) return null;
  try {
    return await sha256File(join(ctx.workDir, 'preview', `ref-${el.id}.png`));
  } catch (e) {
    if (!(e instanceof StudioError) || e.code !== 'NOT_FOUND') throw e;
    const reason = 'run preview first';
    throw new StudioError('BRIEF_INVALID', reason, {
      issues: [{ path: `elements.${index}.layoutRef`, code: 'BRIEF_INVALID', reason }],
    });
  }
}

// The keyframe's current fingerprint picks the acceptance, so a re-made keyframe un-finishes its video. A given file
// is hashed as it is now, so replacing it un-finishes the video too.
async function keyframeSha(ctx: BriefCtx, brief: Brief, el: Generated): Promise<string | null> {
  if (el.output !== 'video') return null;
  if (el.fromFile !== undefined) return sha256File(briefPath(ctx, el.fromFile));
  if (el.from === undefined) throw new StudioError('UNEXPECTED', `${el.id} opens on nothing`, { element: el.id });
  const keyframe = generatedAt(brief, el.from).el;
  if (keyframe.output !== 'image') {
    throw new StudioError('UNEXPECTED', `${el.id} opens on ${el.from}, which is not an image`, { element: el.id });
  }
  const current = await elementInputHash(ctx, brief, keyframe.id);
  const accepted = acceptedOf(await attempts(ctx.workDir), keyframe.id, current);
  if (accepted === null) {
    throw new StudioError('KEYFRAME_NOT_CONFIRMED', `keyframe ${keyframe.id} has no accepted attempt for its inputs`, {
      element: el.id,
      keyframe: keyframe.id,
    });
  }
  if (accepted.last.sha256 === null) {
    throw new StudioError('UNEXPECTED', `accepted attempt ${accepted.attempt} has no file sha`, {
      attempt: accepted.attempt,
    });
  }
  return accepted.last.sha256;
}

export async function elementInputHash(ctx: BriefCtx, brief: Brief, elementId: string): Promise<string> {
  const { el, index } = generatedAt(brief, elementId);
  const { w, h } = elementSize(ctx, brief, elementId);
  return inputHash({
    model: el.model,
    prompt: el.prompt,
    size: [w, h],
    durationMs: el.output === 'video' ? el.durationMs : null,
    refShas: await refShas(ctx, el),
    layoutRefSha: await layoutRefSha(ctx, el, index),
    keyframeSha: await keyframeSha(ctx, brief, el),
    ...(el.output === 'video' && el.toFile !== undefined
      ? { lastFrameSha: await sha256File(briefPath(ctx, el.toFile)) }
      : {}),
  });
}
