import { stat } from 'node:fs/promises';
import { StudioError } from '../errors.ts';
import { absolutePath, driveHint } from '../home.ts';
import { speechSegments } from '../make/index.ts';
import { type Command, errno, parse, single, usageError } from './shared.ts';

const USAGE = 'speech <absolute-file>';

export const speech: Command = async (args, app) => {
  const { positionals } = parse(args, {}, USAGE);
  const file = single(positionals, USAGE);
  // The cwd is wherever the shell running the command is, not the work, so a relative path could name another file.
  if (!absolutePath(file, app.platform)) {
    throw usageError(USAGE, `${file} is relative; pass an absolute path${driveHint(app.platform)}`);
  }
  await stat(file).catch((e: unknown) => {
    if (errno(e, 'ENOENT')) throw new StudioError('NOT_FOUND', `no file at ${file}`, { file });
    throw e;
  });
  return { file, ...(await speechSegments(file)) };
};
