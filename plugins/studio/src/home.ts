// The home folder and the absolute-path rule, per platform. Only `node:` modules at run time: the guard hook needs the
// home folder and must not load config.ts, which reaches the drawing package through the works barrel.
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import type { Env } from './config.ts';

// A drive with its separator, or a UNC path. `/c/work` (Git Bash) and `\work` name no drive: Windows would resolve
// them against the current drive, so the same text could name a different folder from run to run.
const WIN_ABSOLUTE = /^([A-Za-z]:[\\/]|\\\\)/;

// The plugin's folder under the home folder: config.json, and the key file where no keychain holds the key. config.ts
// puts its files there and the guard protects it, so both take it from here.
export const CONFIG_FOLDER_NAME = 'studio-plugin';
export const CONFIG_FOLDER = ['.config', CONFIG_FOLDER_NAME] as const;
// The key file in that folder: the key store writes it and the guard refuses to read it.
export const KEY_FILE = 'provider-key.json';

export function pathFor(platform: NodeJS.Platform): typeof win32 {
  return platform === 'win32' ? win32 : posix;
}

export function absolutePath(p: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? WIN_ABSOLUTE.test(p) : posix.isAbsolute(p);
}

// Said when userHome finds no absolute home folder.
export const NO_HOME_FOLDER = 'cannot find your home folder (HOME, or USERPROFILE on Windows)';

// Appended to a refusal of a path that is not absolute: on Windows the likely mistake is a drive-less path.
export function driveHint(platform: NodeJS.Platform): string {
  return platform === 'win32' ? '; write it with its drive, like C:/…' : '';
}

// A home that is not absolute would put the config under whatever folder the process runs in, the user's project.
export function userHome(
  env: Env,
  platform: NodeJS.Platform = process.platform,
  fallback: () => string = homedir,
): string | null {
  const given = platform === 'win32' ? env.USERPROFILE : env.HOME;
  const home = given === undefined || given === '' ? fallback() : given;
  return absolutePath(home, platform) ? home : null;
}

// A bare `~` is left as it is, so the caller refuses it as a relative path.
export function expandTilde(raw: string, home: string, platform: NodeJS.Platform): string {
  const tilde = raw.startsWith('~/') || (platform === 'win32' && raw.startsWith('~\\'));
  return tilde ? pathFor(platform).join(home, raw.slice(2)) : raw;
}
