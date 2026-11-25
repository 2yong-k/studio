import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { SKRSContext2D } from '@napi-rs/canvas';
import { StudioError } from '../../errors.ts';
import type { Kit } from './kit.ts';
import type { SceneApi } from './timeline.ts';

export type SceneModule = { draw(g: SKRSContext2D, t: number, S: SceneApi, kit: Kit): void };

// A convention check, not a sandbox: globals stay reachable, so scenes are trusted as Claude's own files.
const REACHES_OUT = /^\s*import\b|\bimport\s*\(|\brequire\s*\(/m;

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function loadScene(file: string): Promise<SceneModule> {
  const fail = (why: string): StudioError =>
    new StudioError('SCENE_FAILED', `the scene ${file} cannot be used: ${why}`, { file });
  try {
    if (REACHES_OUT.test(await readFile(file, 'utf8'))) {
      throw fail('a scene takes everything as arguments, so it has no import or require');
    }
    const loaded: unknown = await import(pathToFileURL(file).href);
    const scene = typeof loaded === 'object' && loaded !== null && 'default' in loaded ? loaded.default : undefined;
    const draw: unknown = typeof scene === 'object' && scene !== null && 'draw' in scene ? scene.draw : undefined;
    if (typeof draw !== 'function') throw fail('it must `export default { draw(g, t, S, kit) { … } }`');
    // draw is called as a method, so it keeps the scene object as `this`.
    return { draw: (g, t, S, kit) => Reflect.apply(draw, scene, [g, t, S, kit]) };
  } catch (e) {
    throw e instanceof StudioError ? e : fail(reasonOf(e));
  }
}
