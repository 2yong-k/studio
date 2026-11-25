import { platformVoice, renderPreview } from '../make/index.ts';
import { type Command, loadWork, parse, single } from './shared.ts';

const USAGE = 'preview <work>';

export const preview: Command = async (args, app) => {
  const { positionals } = parse(args, {}, USAGE);
  const w = await loadWork(app, single(positionals, USAGE));
  const out = await renderPreview(w.ctx, w.brief, { source: platformVoice(app.platform, app.env) });
  return {
    work: w.work,
    video: out.video,
    frames: out.frames,
    layoutRefs: out.layoutRefs,
    warnings: out.warnings,
    voice: out.voice,
  };
};
