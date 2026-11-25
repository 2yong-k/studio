import { join } from 'node:path';
import { z } from 'zod';
import { StudioError } from '../errors.ts';
import { readJson } from './files.ts';

const License = z.strictObject({
  name: z.string().min(1),
  commercialUse: z.boolean(),
  source: z.string().min(1),
  checkedAt: z.string().min(1),
});

const AssetFile = z.strictObject({
  schema: z.literal(1),
  files: z.record(z.string(), z.strictObject({ license: License })),
});

export type AssetLicense = { name: string; commercialUse: true; source: string; checkedAt: string };

// `assets/<name>/<rest>`; a `.`/`..` folder name would read an asset.json outside the asset folders.
function split(file: string): { name: string; rest: string } | null {
  const [root, name, ...tail] = file.split('/');
  const rest = tail.join('/');
  if (root !== 'assets' || name === undefined || rest === '') return null;
  if (name === '' || name === '.' || name === '..') return null;
  return { name, rest };
}

// Only a recorded, commercial-use licence counts; anything unrecorded is treated as not allowed (hard rule 5).
export async function licenseOf(home: string, file: string): Promise<AssetLicense | null> {
  const parts = split(file);
  if (parts === null) return null;
  const record = await readJson(join(home, 'assets', parts.name, 'asset.json'), AssetFile).catch((e: unknown) => {
    if (e instanceof StudioError && e.code === 'NOT_FOUND') return null;
    throw e;
  });
  const license = record?.files[parts.rest]?.license;
  if (license === undefined || !license.commercialUse) return null;
  return { name: license.name, commercialUse: true, source: license.source, checkedAt: license.checkedAt };
}
