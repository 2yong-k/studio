import { StudioError } from '../errors.ts';
import { budgetOf, REQUEST_ID_PATTERN, resolveFailed, resolveSubmitting } from '../generate/index.ts';
import { requestIdOwner } from '../works/index.ts';
import { type Command, pair, parse, usageError, workDirOf } from './shared.ts';

const USAGE = 'resolve <work> <attempt> --not-sent | --request-id <id> | --failed';

type Resolution = { notSent: true } | { requestId: string } | { failed: true };

function resolutionOf(notSent: boolean, requestId: string | undefined, failed: boolean): Resolution {
  const given = [notSent, requestId !== undefined, failed].filter((g) => g).length;
  if (given !== 1) throw usageError(USAGE, 'give exactly one of --not-sent, --request-id <id> and --failed');
  if (requestId === undefined) return failed ? { failed: true } : { notSent: true };
  // A typo here would make every later status fail, so it is refused before it is recorded.
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw usageError(USAGE, 'a request id is 1 to 128 letters, digits, "_" or "-"');
  }
  return { requestId };
}

// The user copies the id from the console by hand; one another attempt holds, in any work, would count that request twice.
async function refuseHeldId(worksRoot: string, attempt: string, requestId: string): Promise<void> {
  const owner = await requestIdOwner(worksRoot, requestId);
  if (owner === null || owner === attempt) return;
  const why = `request id ${requestId} already belongs to ${owner}; check the console for this attempt's own id`;
  throw new StudioError('USAGE', why, { requestId, attempt, heldBy: owner });
}

async function applied(workDir: string, attempt: string, r: Resolution): Promise<'not_sent' | 'sent' | 'failed'> {
  if ('failed' in r) {
    await resolveFailed(workDir, attempt);
    return 'failed';
  }
  await resolveSubmitting(workDir, attempt, r);
  return 'notSent' in r ? 'not_sent' : 'sent';
}

// Run only after the user checked the provider console and said what it shows; this records the answer, it sends nothing.
export const resolve: Command = async (args, app) => {
  const options = {
    'not-sent': { type: 'boolean' },
    'request-id': { type: 'string' },
    failed: { type: 'boolean' },
  } as const;
  const { values, positionals } = parse(args, options, USAGE);
  const [work, attempt] = pair(positionals, USAGE);
  const resolution = resolutionOf(values['not-sent'] === true, values['request-id'], values.failed === true);
  const workDir = await workDirOf(app, work);
  if ('requestId' in resolution) await refuseHeldId(app.worksRoot, attempt, resolution.requestId);
  const resolved = await applied(workDir, attempt, resolution);
  return { work, attempt, resolved, ...(await budgetOf(workDir)) };
};
