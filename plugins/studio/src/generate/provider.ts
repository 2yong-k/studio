import type { JsonValue } from '../errors.ts';

// A price exactly as the provider states it; the estimate checks currency and unit before reading the number.
export type PriceQuote = { endpoint: string; unit: string; unitPriceUsd: string; currency: string };
export type Expect = {
  output: 'image' | 'video';
  w: number;
  h: number;
  durationMs: number | null;
  fps: number | null;
  audio: boolean;
};
export type SubmitInput = { endpoint: string; params: Readonly<Record<string, JsonValue>>; expect: Expect };
export type ProviderStatus = { state: 'queued' | 'running' | 'completed' | 'failed'; error: string | null };
export type ResultFile = { url: string; contentType: string | null };
export type ProviderUsage = { unit: string; quantity: string };
export type ProviderResult =
  | {
      state: 'done';
      files: ResultFile[];
      // Settles the attempt only when it counts more than the request computes; a smaller figure may cover only part.
      usage: ProviderUsage | null;
    }
  // The provider's own answer that it will not make this input, which no retry of the same input changes.
  | { state: 'refused'; error: string };

// Only what reads back cleanly into the status and result URL paths; a mistyped id is refused before it is recorded.
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// The one shape every generation service is reached through, so nothing outside its adapter names the service.
export interface Provider {
  // A host matches an entry exactly, or ends with an entry that starts with '.'.
  readonly allowedHosts: readonly string[];
  price(endpoints: readonly string[]): Promise<PriceQuote[]>;
  upload(file: string): Promise<string>;
  submit(x: SubmitInput): Promise<{ requestId: string }>;
  status(endpoint: string, requestId: string): Promise<ProviderStatus>;
  result(endpoint: string, requestId: string): Promise<ProviderResult>;
  download(url: string, dest: string, maxBytes: number): Promise<void>;
}
