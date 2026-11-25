import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cheapestImageModel, type SmokeBase, type SmokeModel } from '../generate/index.ts';
import { platformVoice, renderPreview } from '../make/index.ts';
import { type Brief, loadModels } from '../works/index.ts';
import { estimateWork } from './estimate.ts';
import { createWork, localTime } from './new.ts';
import { type Command, loadWork, parse, usageError } from './shared.ts';

const USAGE = 'smoke';
const SMOKE: SmokeBase = {
  id: 'smoke',
  label: 'smoke',
  prompt: 'A plain gray card on a white table in soft daylight.',
};

// The element goes in as the pick priced it, so the estimate prices the same thing the pick ranked. Typed as a
// brief so a wrong shape fails to compile; loading it still checks the ranges.
function smokeBrief(work: string, pick: SmokeModel): Brief {
  return {
    schema: 1,
    work,
    kind: 'image',
    intent: 'Smoke test: make the cheapest single image through the ordinary estimate, approval and spend path',
    mood: 'plain',
    frame: { width: pick.w, height: pick.h },
    elements: [pick.element],
    layout: [{ element: pick.element.id, rect: [0, 0, pick.w, pick.h], z: 0 }],
  };
}

// Stops at the estimate: approving and generating it go through the ordinary commands, with no money path of its own.
export const smoke: Command = async (args, app) => {
  const { positionals } = parse(args, {}, USAGE);
  if (positionals.length > 0) throw usageError(USAGE, 'smoke takes no arguments');
  const provider = await app.provider();
  const now = app.now();
  const models = await loadModels(app.repoRoot, app.home);
  const pick = await cheapestImageModel(models, provider, SMOKE, now, app.mode === 'live');
  const { work, workDir } = await createWork(app, `smoke-${localTime(now)}`, now);
  await writeFile(join(workDir, 'brief.json'), `${JSON.stringify(smokeBrief(work, pick), null, 2)}\n`, { flag: 'wx' });
  const w = await loadWork(app, work);
  // The model needs one reference; the layout guide the preview draws is that one.
  if (pick.element.layoutRef === true)
    await renderPreview(w.ctx, w.brief, { source: platformVoice(app.platform, app.env) });
  return { ...(await estimateWork(app, w, provider)), model: pick.element.model };
};
