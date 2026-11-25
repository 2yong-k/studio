import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type JsonValue, StudioError } from '../errors.ts';
import { replaceFile, sha256File } from '../works/index.ts';
import type { Provider } from './provider.ts';

function rejected(message: string, details: JsonValue): StudioError {
  return new StudioError('DOWNLOAD_REJECTED', message, details);
}

// A host passes when it equals an entry, or ends with an entry written with a leading dot (its subdomains).
function hostAllowed(host: string, allowed: readonly string[]): boolean {
  return allowed.some((a) => (a.startsWith('.') ? host.endsWith(a) : host === a));
}

// Result URLs come from the provider's response, so they are checked before anything is fetched.
function checkUrl(p: Provider, url: string): void {
  const parsed = URL.canParse(url) ? new URL(url) : null;
  if (parsed === null) throw rejected('the result URL does not parse', { url });
  if (parsed.protocol !== 'https:') throw rejected('the result URL is not https', { url });
  if (!hostAllowed(parsed.hostname, p.allowedHosts)) {
    throw rejected(`the result host ${parsed.hostname} is not allowed`, { url, host: parsed.hostname });
  }
}

// The file lands under `.part` and is renamed only once it passed, so a failed fetch never replaces `dest`.
export async function downloadChecked(p: Provider, url: string, dest: string, maxBytes: number): Promise<string> {
  checkUrl(p, url);
  const part = `${dest}.part`;
  await mkdir(dirname(dest), { recursive: true });
  await p.download(url, part, maxBytes);
  const { size } = await stat(part);
  if (size > maxBytes) {
    throw rejected(`the file is ${size} bytes, over the ${maxBytes} byte limit`, { url, size, maxBytes });
  }
  const sha256 = await sha256File(part);
  await replaceFile(part, dest);
  return sha256;
}
