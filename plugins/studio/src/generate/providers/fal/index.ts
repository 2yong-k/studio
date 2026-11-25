import { createWriteStream, openAsBlob } from 'node:fs';
import { extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ApiError, createFalClient } from '@fal-ai/client';
import { z } from 'zod';
import { type ErrorCode, type JsonValue, StudioError } from '../../../errors.ts';
import { priceNumberToDecimal } from '../../../money/index.ts';
import {
  type PriceQuote,
  type Provider,
  type ProviderResult,
  type ProviderStatus,
  REQUEST_ID_PATTERN,
  type ResultFile,
} from '../../provider.ts';

type JsonObject = { [k: string]: JsonValue };

// https://fal.ai/docs/model-apis/model-endpoints/queue
const QUEUE_URL = 'https://queue.fal.run';
// https://fal.ai/docs/platform-apis/v1/models/pricing — "Accepts 1-50 endpoint IDs".
const PRICING_URL = 'https://api.fal.ai/v1/models/pricing';
const MAX_PRICED_ENDPOINTS = 50;
// v3.fal.media, v3b.fal.media and plain fal.media are the documented media hosts
// (https://fal.ai/docs/documentation/model-apis/fal-cdn). storage.googleapis.com shows up only in example
// outputs, and allowing it would admit any bucket.
const MEDIA_HOSTS = ['.fal.media', 'fal.media'];
// A stalled connection would otherwise hang the command; API answers take seconds and uploads are reference images.
const REQUEST_TIMEOUT_MS = 60_000;
// Room for a 1 GB video on a slow link; past it the attempt stays open and the file can be fetched again.
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const EXCERPT_MAX = 300;
// About 50 entries of about 100 characters, one full answer, still short enough to read on stdout.
const RECEIVED_MAX = 5000;
const REDACTED = '[key]';
// A shorter half of a key could match ordinary text, so only pieces at least this long are hidden on their own.
const MIN_KEY_PIECE = 8;
const CONTENT_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.mp4', 'video/mp4'],
]);

// The docs require all four fields; an unknown one could change what the number means, so it is refused.
// z.number() already refuses NaN and ±Infinity.
const PriceEntrySchema = z.strictObject({
  endpoint_id: z.string().min(1),
  unit_price: z.number().nonnegative(),
  unit: z.string().min(1),
  currency: z.string().length(3),
});

const PricingSchema = z.object({
  prices: z.array(PriceEntrySchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

// Documented ids are UUIDs.
const SubmitSchema = z.object({ request_id: z.string().regex(REQUEST_ID_PATTERN) });
const SubmittedIdSchema = z.object({ request_id: z.string() });
const PricesSchema = z.object({ prices: z.json() });

// `error` and `error_type` are present only on a failed request and missing from the SDK's type
// (https://fal.ai/docs/api-reference/inference-api/queue/status.md).
const StatusSchema = z.object({
  status: z.enum(['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED']),
  error: z.string().nullish(),
  error_type: z.string().nullish(),
});

// Every documented output is an object; a string (a text/html body) or an array would read as "no files" and settle.
const ResultSchema = z.record(z.string(), z.json());
const FileSchema = z.object({ url: z.string().min(1), content_type: z.string().nullish() });
// A model or input error (https://fal.ai/docs/errors): every documented type is not retryable, and an unlisted one is
// to be read the same way. The shape is keyed on `type` alone; any other 422 body is not known to be a refusal, so it
// is left open rather than settled.
const RefusalSchema = z.looseObject({
  detail: z
    .array(z.looseObject({ type: z.string().min(1), msg: z.unknown().optional(), loc: z.unknown().optional() }))
    .min(1),
});
// Where a 422 points into the result request itself (id, flags, key, cookies) rather than the input the model judged.
const REQUEST_LOCS: ReadonlySet<string> = new Set(['path', 'query', 'header', 'cookie']);
const UploadedSchema = z.url({ protocol: /^https$/ });

function aboutRequest(loc: unknown): boolean {
  const first: unknown = Array.isArray(loc) ? loc[0] : undefined;
  return typeof first === 'string' && REQUEST_LOCS.has(first);
}

function badParam(key: string): StudioError {
  return new StudioError('UNEXPECTED', `param ${JSON.stringify(key)} cannot be expanded into a nested field`, {
    param: key,
  });
}

// Model data writes nested params as dotted keys ("image_size.width"); the API takes the nested object. A key that
// collides with another is refused rather than merged, and '__proto__' would set a prototype instead of a field.
function expandParams(params: Readonly<Record<string, JsonValue>>): JsonObject {
  const root: JsonObject = {};
  const made = new Map<string, JsonObject>();
  for (const [key, value] of Object.entries(params)) {
    const parents = key.split('.');
    const leaf = parents.pop() ?? '';
    if ([...parents, leaf].some((seg) => seg === '' || seg === '__proto__')) throw badParam(key);
    let node = root;
    let prefix = '';
    for (const seg of parents) {
      prefix = prefix === '' ? seg : `${prefix}.${seg}`;
      let child = made.get(prefix);
      if (child === undefined) {
        if (Object.hasOwn(node, seg)) throw badParam(key);
        child = {};
        node[seg] = child;
        made.set(prefix, child);
      }
      node = child;
    }
    if (Object.hasOwn(node, leaf)) throw badParam(key);
    node[leaf] = value;
  }
  return root;
}

// Outputs differ per endpoint (`images[]`, `video{}`), so every object that carries a `url` counts as a file.
function fileObjects(v: JsonValue): JsonValue[] {
  if (Array.isArray(v)) return v.flatMap(fileObjects);
  if (v === null || typeof v !== 'object') return [];
  if (Object.hasOwn(v, 'url')) return [v];
  return Object.values(v).flatMap(fileObjects);
}

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function thrownText(e: unknown): string {
  if (!(e instanceof Error)) return 'a non-error value was thrown';
  return e.cause instanceof Error ? `${e.name}: ${e.message} (${e.cause.message})` : `${e.name}: ${e.message}`;
}

// The cap is checked per chunk, so an oversized or endless body stops at the limit instead of filling the disk.
async function* capped(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
  tooBig: () => StudioError,
): AsyncGenerator<Uint8Array> {
  let seen = 0;
  for await (const chunk of body) {
    seen += chunk.byteLength;
    if (seen > maxBytes) throw tooBig();
    yield chunk;
  }
}

export function createFalProvider(o: { key: string; fetch?: typeof fetch }): Provider {
  const fetchFn = o.fetch ?? fetch;
  // A caller's own signal wins; the SDK passes none, so its calls (and their retries) each get the deadline here.
  const bounded: typeof fetch = (input, init) =>
    fetchFn(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  // Left out, the SDK reads FAL_KEY from the environment, which only the config module may read.
  const client = createFalClient({ credentials: o.key, fetch: bounded });
  const auth = { Authorization: `Key ${o.key}` };
  // The SDK builds keys as "<id>:<secret>" (src/config.js); a server could echo either half, so each is hidden too.
  const halves = o.key.split(':').filter((p) => p.length >= MIN_KEY_PIECE && p !== o.key);
  const secrets = [o.key, ...halves].filter((p) => p !== '');
  const redact = (s: string): string => secrets.reduce((acc, secret) => acc.split(secret).join(REDACTED), s);

  function redactJson(v: JsonValue): JsonValue {
    if (typeof v === 'string') return redact(v);
    if (Array.isArray(v)) return v.map(redactJson);
    if (v === null || typeof v !== 'object') return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [redact(k), redactJson(x)]));
  }

  // Every adapter error passes here, since response text could echo the key and errors reach stdout.
  const fail = (code: ErrorCode, message: string, details: JsonObject): StudioError =>
    new StudioError(code, redact(message), redactJson(details));

  // Hidden before cutting, so a key that straddles the cut never leaves a piece behind.
  const excerpt = (text: string): string => (text === '' ? '' : ` ${redact(text).slice(0, EXCERPT_MAX)}`);

  function schemaError(what: string, error: z.ZodError, ctx: JsonObject): StudioError {
    const issues = error.issues.map((i) => ({ path: i.path.map((seg) => String(seg)).join('.'), message: i.message }));
    return fail('PROVIDER_ERROR', `${what}: the response does not match its schema`, { ...ctx, issues });
  }

  function parsed<S extends z.ZodType>(schema: S, value: unknown, what: string, ctx: JsonObject): z.infer<S> {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    throw schemaError(what, result.error, ctx);
  }

  // One fetch and never a second: no retry happens here.
  async function send(what: string, url: string, init: RequestInit, ctx: JsonObject): Promise<unknown> {
    let res: Response;
    let text: string;
    try {
      res = await bounded(url, init);
      text = await res.text();
    } catch (e) {
      throw fail('PROVIDER_ERROR', `${what}: the request did not complete: ${thrownText(e)}`, ctx);
    }
    const { status } = res;
    if (!res.ok) throw fail('PROVIDER_ERROR', `${what}: HTTP ${status}${excerpt(text)}`, { ...ctx, status });
    const body = jsonOf(text);
    if (body === undefined) throw fail('PROVIDER_ERROR', `${what}: the response is not JSON`, { ...ctx, status });
    return body;
  }

  function clientError(what: string, ctx: JsonObject, e: unknown): StudioError {
    if (e instanceof ApiError) {
      const body = e.body === undefined ? '' : JSON.stringify(e.body);
      return fail('PROVIDER_ERROR', `${what}: HTTP ${e.status}${excerpt(body)}`, { ...ctx, status: e.status });
    }
    return fail('PROVIDER_ERROR', `${what}: the request did not complete: ${thrownText(e)}`, ctx);
  }

  async function viaClient<T>(what: string, ctx: JsonObject, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (e) {
      throw clientError(what, ctx, e);
    }
  }

  // The types name what was refused; the docs ask that `msg` not be parsed, so it rides along only as text.
  function refusalOf(e: unknown): string | null {
    if (!(e instanceof ApiError) || e.status !== 422) return null;
    const body = RefusalSchema.safeParse(e.body);
    if (!body.success || body.data.detail.some((d) => aboutRequest(d.loc))) return null;
    const types = body.data.detail.map((d) => d.type).join(', ');
    const msg = body.data.detail.map((d) => d.msg).find((m): m is string => typeof m === 'string' && m !== '');
    return redact(msg === undefined ? types : `${types}: ${msg}`).slice(0, EXCERPT_MAX);
  }

  return {
    allowedHosts: MEDIA_HOSTS,

    async price(endpoints): Promise<PriceQuote[]> {
      if (endpoints.length === 0) return [];
      // The API's own limit, met only when a caller names too many: theirs to fix, so USAGE rather than a bug.
      if (endpoints.length > MAX_PRICED_ENDPOINTS) {
        throw new StudioError('USAGE', `the pricing API takes at most ${MAX_PRICED_ENDPOINTS} endpoints a call`, {
          count: endpoints.length,
        });
      }
      const ctx = { endpoints: [...endpoints] };
      const query = endpoints.map(encodeURIComponent).join(',');
      const body = await send('price', `${PRICING_URL}?endpoint_id=${query}`, { method: 'GET', headers: auth }, ctx);
      const result = PricingSchema.safeParse(body);
      if (!result.success) {
        // The entries as received, so a schema miss shows what the API actually answered.
        const prices = PricesSchema.safeParse(body);
        const received = prices.success ? redact(JSON.stringify(prices.data.prices)).slice(0, RECEIVED_MAX) : null;
        throw schemaError('price', result.error, { ...ctx, received });
      }
      const page = result.data;
      // The docs name no request parameter for the next page, so a partial list is refused rather than read.
      if (page.has_more) throw fail('PROVIDER_ERROR', 'price: the pricing API answered with more than one page', ctx);
      // Every entry passes through as stated; the estimate decides what more than one per endpoint means.
      return page.prices.map((p) => ({
        endpoint: p.endpoint_id,
        unit: p.unit,
        unitPriceUsd: priceNumberToDecimal(p.unit_price),
        currency: p.currency,
      }));
    },

    async upload(file): Promise<string> {
      const type = CONTENT_TYPES.get(extname(file).toLowerCase()) ?? '';
      // openAsBlob throws synchronously for a missing file, so the call sits inside try rather than behind .catch.
      let blob: Blob;
      try {
        blob = await openAsBlob(file, { type });
      } catch (e) {
        throw fail('UNEXPECTED', `upload: cannot read ${file}: ${thrownText(e)}`, { file });
      }
      const url = await viaClient('upload', { file }, () => client.storage.upload(blob));
      return parsed(UploadedSchema, url, 'upload', { file });
    },

    // A raw POST rather than the SDK's queue.submit, which retries 429, 5xx and dropped connections up to three
    // times whatever retry config it is given; a resent submit can be billed twice.
    async submit(x): Promise<{ requestId: string }> {
      const ctx = { endpoint: x.endpoint };
      const init = {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(expandParams(x.params)),
      };
      const body = await send('submit', `${QUEUE_URL}/${x.endpoint}`, init, ctx);
      const result = SubmitSchema.safeParse(body);
      if (result.success) return { requestId: result.data.request_id };
      // The queue took the request, so money may be spent: an odd id is kept, in the message too since only the
      // message reaches the attempt's cause, for settling by hand.
      const sent = SubmittedIdSchema.safeParse(body);
      if (!sent.success) throw schemaError('submit', result.error, ctx);
      const requestId = redact(sent.data.request_id).slice(0, EXCERPT_MAX);
      const message = `submit: the request id ${JSON.stringify(requestId)} has an unexpected form`;
      throw fail('PROVIDER_ERROR', message, { ...ctx, requestId });
    },

    async status(endpoint, requestId): Promise<ProviderStatus> {
      const ctx = { endpoint, requestId };
      const raw = await viaClient('status', ctx, () => client.queue.status(endpoint, { requestId, logs: false }));
      const s = parsed(StatusSchema, raw, 'status', ctx);
      if (s.status === 'IN_QUEUE') return { state: 'queued', error: null };
      if (s.status === 'IN_PROGRESS') return { state: 'running', error: null };
      // A failed or cancelled request is COMPLETED too, told apart only by `error` and `error_type`.
      const stated = [s.error_type, s.error].filter((t): t is string => t !== undefined && t !== null);
      if (stated.length === 0) return { state: 'completed', error: null };
      const text = stated.filter((t) => t !== '').join(': ');
      return { state: 'failed', error: redact(text === '' ? 'failed without a message' : text).slice(0, EXCERPT_MAX) };
    },

    // The queue reports a request its input filter stopped as COMPLETED; the refusal shows only here, as a 422.
    async result(endpoint, requestId): Promise<ProviderResult> {
      const ctx = { endpoint, requestId };
      let data: unknown;
      try {
        ({ data } = await client.queue.result(endpoint, { requestId }));
      } catch (e) {
        const refused = refusalOf(e);
        if (refused !== null) return { state: 'refused', error: refused };
        throw clientError('result', ctx, e);
      }
      const files = fileObjects(parsed(ResultSchema, data, 'result', ctx)).map((f): ResultFile => {
        const file = parsed(FileSchema, f, 'result', ctx);
        return { url: file.url, contentType: file.content_type ?? null };
      });
      // None of the endpoints in use document usage fields in their output.
      return { state: 'done', files, usage: null };
    },

    // No headers at all: media URLs are public, and the key must never reach a media host. A redirect is refused,
    // since only the first URL's host and scheme were checked against allowedHosts.
    async download(url, dest, maxBytes): Promise<void> {
      const ctx = { url };
      let res: Response;
      try {
        res = await fetchFn(url, {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
      } catch (e) {
        throw fail('PROVIDER_ERROR', `download: the request did not complete: ${thrownText(e)}`, ctx);
      }
      if (!res.ok || res.body === null) {
        await res.body?.cancel();
        throw fail('PROVIDER_ERROR', `download: HTTP ${res.status}`, { ...ctx, status: res.status });
      }
      try {
        const tooBig = (): StudioError =>
          fail('DOWNLOAD_REJECTED', `the file is over the ${maxBytes} byte limit`, { url, maxBytes });
        await pipeline(capped(res.body, maxBytes, tooBig), createWriteStream(dest));
      } catch (e) {
        if (e instanceof StudioError) throw e;
        throw fail('PROVIDER_ERROR', `download: the transfer did not complete: ${thrownText(e)}`, ctx);
      }
    },
  };
}
