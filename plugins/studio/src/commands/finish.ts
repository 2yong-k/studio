import { randomBytes } from 'node:crypto';
import { constants, copyFile, link, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { StudioError } from '../errors.ts';
import { budgetOf } from '../generate/index.ts';
import { loadBriefHashed } from '../works/index.ts';
import { briefCtxOf, type Command, errno, parse, single, workDirOf } from './shared.ts';

const USAGE = 'finish <work>';

// A finished copy is linked into place: a link fails on an existing name instead of replacing it, so no final file
// is ever overwritten, and none is ever seen half-written.
async function copyAsNewVersion(src: string, dir: string, base: string, ext: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${base}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await copyFile(src, tmp, constants.COPYFILE_EXCL).catch((e: unknown) => {
      if (errno(e, 'ENOENT'))
        throw new StudioError('NOT_FOUND', `no candidate at ${src}; run make first`, { file: src });
      throw e;
    });
    for (let n = 1; ; n += 1) {
      const dest = join(dir, n === 1 ? `${base}.${ext}` : `${base}-v${n}.${ext}`);
      try {
        await link(tmp, dest);
        return dest;
      } catch (e) {
        if (!errno(e, 'EEXIST')) throw e;
      }
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

// Run only after the user approved publishing in the conversation.
export const finish: Command = async (args, app) => {
  const { positionals } = parse(args, {}, USAGE);
  const work = single(positionals, USAGE);
  const workDir = await workDirOf(app, work);
  const { brief } = await loadBriefHashed(await briefCtxOf(app, workDir));
  const ext = brief.kind === 'image' ? 'png' : 'mp4';
  const file = await copyAsNewVersion(join(workDir, 'build', `candidate.${ext}`), join(workDir, 'final'), work, ext);
  return { work, file, ...(await budgetOf(workDir)) };
};
