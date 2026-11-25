import { copyFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { StudioError } from '../../../errors.ts';
import { runFfmpeg } from '../../../make/index.ts';
import { readJson, sha256File, writeJsonAtomic } from '../../../works/index.ts';
import type { Expect, PriceQuote, Provider, ProviderResult, ProviderStatus, ResultFile } from '../../provider.ts';

// The CLI checks STUDIO_FAKE_SCENARIO against this list, so a scenario added here is usable without a CLI edit.
export const FAKE_SCENARIOS = ['ok', 'fail', 'timeout', 'wrong_size', 'submit_throws', 'two_files', 'refused'] as const;
export type FakeScenario = (typeof FAKE_SCENARIOS)[number];

const HOST = 'fake.studio.invalid';
const REFUSAL = 'content_policy_violation: the fake input was refused on purpose';

// Recorded page prices for every endpoint in data/models.json; the strings are endpoint data, not names in code.
export const FAKE_PRICES: Readonly<Record<string, { unit: string; unitPriceUsd: string }>> = {
  'openai/gpt-image-2.5/flare/edit': { unit: '1M tokens', unitPriceUsd: '30' },
  'openai/gpt-image-2.5/sunburst/edit': { unit: '1M tokens', unitPriceUsd: '30' },
  'google/nano-banana-2.1/edit': { unit: '1M tokens', unitPriceUsd: '35.294' },
  'fal-ai/nano-banana-pro/edit': { unit: 'images', unitPriceUsd: '0.15' },
  'bytedance/seedance-2.5/image-to-video': { unit: '1000 tokens', unitPriceUsd: '0.0214' },
  'alibaba/happy-horse/v1.1/image-to-video': { unit: 'seconds', unitPriceUsd: '0.14' },
  'minimax/h3/image-to-video': { unit: 'seconds', unitPriceUsd: '0.05' },
  'heygen/heygen-video/image-to-video': { unit: 'seconds', unitPriceUsd: '0.01' },
  'alibaba/wan-3.0/image-to-video': { unit: 'seconds', unitPriceUsd: '0.05' },
};

const STATE_FILE = 'fake-jobs.json';
const FILE_PATH = /^\/(fake-[1-9][0-9]*)\/([1-9][0-9]*)\.(png|mp4)$/;

const ExpectSchema = z.strictObject({
  output: z.enum(['image', 'video']),
  w: z.int().positive(),
  h: z.int().positive(),
  durationMs: z.int().nonnegative().nullable(),
  // Jobs recorded before the field existed read as no frame rate, and their clips keep the encoder default.
  fps: z.int().positive().nullable().default(null),
  audio: z.boolean(),
}) satisfies z.ZodType<Expect>;

const JobSchema = z.strictObject({
  endpoint: z.string().min(1),
  expect: ExpectSchema,
  polls: z.int().nonnegative(),
  completed: z.boolean(),
});

// On disk rather than in the instance, so a later instance on the same scratch dir (a scenario switch, or
// `status` in another process) sees the requests already made and never hands out an id twice.
const StateSchema = z.strictObject({
  schema: z.literal(1),
  submitted: z.int().nonnegative(),
  jobs: z.record(z.string(), JobSchema),
});

type Job = z.infer<typeof JobSchema>;
type State = z.infer<typeof StateSchema>;

// Own keys only, so an endpoint such as "constructor" is not priced from Object.prototype.
function quoteOf(endpoint: string): PriceQuote[] {
  const price = Object.hasOwn(FAKE_PRICES, endpoint) ? FAKE_PRICES[endpoint] : undefined;
  return price === undefined ? [] : [{ endpoint, ...price, currency: 'USD' }];
}

// H.264 with yuv420p needs even sides, so the deliberately wrong size stays encodable.
const halfEven = (n: number): number => Math.floor(n / 4) * 2;

// A tone from 0.4 to 1.6 s of every 2 s, so `speech` finds talk-like segments in a fake clip as it would in speech.
const TALK = "aevalsrc=exprs='0.5*sin(2*PI*440*t)*between(mod(t,2),0.4,1.6)'";

function makeArgs(x: Expect, w: number, h: number, out: string): string[] {
  if (x.output === 'image') return ['-f', 'lavfi', '-i', `color=c=gray:s=${w}x${h}`, '-frames:v', '1', out];
  if (x.durationMs === null) throw new StudioError('UNEXPECTED', 'a fake video needs a duration', { expect: x });
  const rate = x.fps === null ? '' : `:r=${x.fps}`;
  const input = ['-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}${rate}`];
  const audioIn = x.audio ? ['-f', 'lavfi', '-i', TALK] : [];
  const videoOut = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
  const audioOut = x.audio ? ['-c:a', 'aac'] : [];
  return [...input, ...audioIn, '-t', `${x.durationMs}ms`, ...videoOut, ...audioOut, out];
}

export function createFakeProvider(o: {
  scenario: FakeScenario;
  scratchDir: string;
  pollsUntilDone?: number;
}): Provider {
  const pollsUntilDone = o.pollsUntilDone ?? 1;
  const statePath = join(o.scratchDir, STATE_FILE);
  let uploaded = 0;

  async function readState(): Promise<State> {
    try {
      return await readJson(statePath, StateSchema);
    } catch (e) {
      if (e instanceof StudioError && e.code === 'NOT_FOUND') return { schema: 1, submitted: 0, jobs: {} };
      throw e;
    }
  }

  async function writeState(state: State): Promise<void> {
    await mkdir(o.scratchDir, { recursive: true });
    await writeJsonAtomic(statePath, StateSchema, state);
  }

  function jobOf(state: State, endpoint: string, requestId: string): Job {
    const job = Object.hasOwn(state.jobs, requestId) ? state.jobs[requestId] : undefined;
    if (job === undefined || job.endpoint !== endpoint) {
      throw new StudioError('PROVIDER_ERROR', `the fake has no request ${requestId} on ${endpoint}`, {
        endpoint,
        requestId,
      });
    }
    return job;
  }

  async function makeFile(requestId: string, k: number, x: Expect): Promise<ResultFile> {
    const [w, h] = o.scenario === 'wrong_size' ? [halfEven(x.w), halfEven(x.h)] : [x.w, x.h];
    const ext = x.output === 'image' ? 'png' : 'mp4';
    const out = join(o.scratchDir, `${requestId}-${k}.${ext}`);
    await runFfmpeg(makeArgs(x, w, h, out));
    return {
      url: `https://${HOST}/${requestId}/${k}.${ext}`,
      contentType: x.output === 'image' ? 'image/png' : 'video/mp4',
    };
  }

  // The URL names the file the fake wrote, so any instance on this scratch dir can serve it.
  function sourceOf(url: string): string {
    const parsed = URL.canParse(url) ? new URL(url) : null;
    const m = parsed?.hostname === HOST ? FILE_PATH.exec(parsed.pathname) : null;
    if (m === null) {
      throw new StudioError('DOWNLOAD_REJECTED', 'the fake made no file at this URL', { url });
    }
    return join(o.scratchDir, `${m[1]}-${m[2]}.${m[3]}`);
  }

  return {
    allowedHosts: [HOST],

    async price(endpoints): Promise<PriceQuote[]> {
      return endpoints.flatMap(quoteOf);
    },

    async upload(file): Promise<string> {
      await sha256File(file);
      uploaded += 1;
      return `https://${HOST}/upload/${uploaded}`;
    },

    async submit(x): Promise<{ requestId: string }> {
      if (o.scenario === 'submit_throws') throw new Error('the fake submit failed on purpose');
      const state = await readState();
      state.submitted += 1;
      const requestId = `fake-${state.submitted}`;
      state.jobs[requestId] = { endpoint: x.endpoint, expect: x.expect, polls: 0, completed: false };
      await writeState(state);
      return { requestId };
    },

    async status(endpoint, requestId): Promise<ProviderStatus> {
      const state = await readState();
      const job = jobOf(state, endpoint, requestId);
      job.polls += 1;
      const running = o.scenario === 'timeout' || job.polls < pollsUntilDone;
      if (!running && o.scenario !== 'fail') job.completed = true;
      await writeState(state);
      if (running) return { state: 'running', error: null };
      if (o.scenario === 'fail') return { state: 'failed', error: 'the fake request failed on purpose' };
      return { state: 'completed', error: null };
    },

    async result(endpoint, requestId): Promise<ProviderResult> {
      const job = jobOf(await readState(), endpoint, requestId);
      if (!job.completed) {
        throw new StudioError('PROVIDER_ERROR', `fake request ${requestId} has not completed`, { endpoint, requestId });
      }
      // Like a provider's input filter: the status completes, and only the result says no.
      if (o.scenario === 'refused') return { state: 'refused', error: REFUSAL };
      await mkdir(o.scratchDir, { recursive: true });
      const count = o.scenario === 'two_files' ? 2 : 1;
      const made: ResultFile[] = [];
      for (let k = 1; k <= count; k += 1) made.push(await makeFile(requestId, k, job.expect));
      return { state: 'done', files: made, usage: null };
    },

    async download(url, dest, maxBytes): Promise<void> {
      const source = sourceOf(url);
      const { size } = await stat(source).catch((e: unknown) => {
        if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
          throw new StudioError('DOWNLOAD_REJECTED', 'the fake made no file at this URL', { url });
        }
        throw e;
      });
      if (size > maxBytes) {
        throw new StudioError('DOWNLOAD_REJECTED', `the file is ${size} bytes, over the ${maxBytes} byte limit`, {
          url,
          size,
          maxBytes,
        });
      }
      await copyFile(source, dest);
    },
  };
}
