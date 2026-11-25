import { realpath } from 'node:fs/promises';
import { parse } from 'node:path';
import { text } from 'node:stream/consumers';
import { z } from 'zod';
import { CONFIG_FOLDER, CONFIG_FOLDER_NAME, expandTilde, KEY_FILE, pathFor, userHome } from '../home.ts';
import {
  dotLed,
  dotQualified,
  globMatcher,
  globWords,
  hasGlob,
  keychainForms,
  nameForms,
  pathSegments,
  type Reading,
  readings,
  SEPARATOR,
  setsDotOption,
  WORD_BREAK,
} from './command-text.ts';

// security runs the first command in its table that starts with the word given, so `f` is find-generic-password.
const READ_COMMANDS = ['find-generic-password', 'find-internet-password'];
const DECRYPT_COMMANDS = ['dump-keychain'];
// getopt reads a bundle's letters left to right and the first one that takes a value swallows the rest, so only the
// leading letters count and a value may follow them: `-wsstudio-fal` is `-w -s studio-fal`. Flags keep their case.
const READ_FLAG = /^-[A-Za-z]*[wg]/;
const DECRYPT_FLAG = /^-[A-Za-z]*d/;
// -p sets the prompt and implies -i.
const INTERACTIVE_FLAG = /^-[A-Za-z]*[ip]/;
// macOS file names ignore case, so `SECURITY` runs the same binary.
const BINARY = /(^|\/)security$/i;
const HINT = 'The CLI reads it itself; run `studio doctor` to check it is stored.';
const KEY_REASON = `studio guard: this reads or writes the stored key. ${HINT}`;
const UNJUDGED_REASON = 'studio guard: this call could not be checked, so it is refused; write it more simply.';
// Claude Code's folder and the file it keeps the login in where no keychain holds it.
export const CLAUDE_FOLDER = '.claude';
export const CREDENTIALS_FILE = '.credentials.json';
const KEY_FILES = [KEY_FILE, CREDENTIALS_FILE];
// The key file, Claude Code's credentials file and the variable a hook gets the option in all hold the key. The key file
// leaves out its extension, so a glob there (`provider-key.js?n`) still names it.
const KEY_NAMES = [parse(KEY_FILE).name, CREDENTIALS_FILE, 'claude_plugin_option_'];
// The credentials file without its extension names it too (`.credentials.js?n`), but only at the start of a name: glued
// after a letter, digit, `_`, `-` or `.` it ends another one (`Rails.application.credentials`, `app.credentials.x`).
const CREDENTIALS_STEM = new RegExp(`(?<![a-z0-9_.-])\\${parse(CREDENTIALS_FILE).name}`);
// Windows also opens a file by its 8.3 short name: the first six letters, `~` and a digit, as in `STUDIO~1`,
// `PROVID~1.JSO` and `CREDEN~1.JSO`. Normalising drops the backslash before it, so it matches anywhere in a word.
const SHORT_NAME = /(?:studio|provid|creden)~\d/;
// The one file in the key folder (the plugin's CONFIG_FOLDER) that holds no key.
const CONFIG_FILE = 'config.json';
const [CONFIG_PARENT] = CONFIG_FOLDER;

// Names compare in the case file systems ignore. Windows upcases a dotless i and a long s to I and S, and macOS folds a
// long s to s, while toLowerCase alone leaves both as they are.
function fold(text: string): string {
  return text.toUpperCase().toLowerCase();
}

// A glob names the key folder when a dot-led segment matches `.config` and the next matches the folder, and that one is
// more than a bare `*` (`stu*-plugin`) or a segment but config.json lies below it. A path with no glob from `.config` on
// is left to the name rules, so `$(pwd)/.config/studio-plugin/config.json` stays allowed. A glob names the credentials
// when a dot-led segment after one that matches `.claude` matches the file.
function globPathNamesKey(word: string, led: (segment: string) => boolean): boolean {
  const segments = pathSegments(word);
  const lastGlob = segments.findLastIndex(hasGlob);
  for (let i = 0; i + 1 < segments.length && i <= lastGlob; i++) {
    const [parent = '', child = '', below] = [segments[i], segments[i + 1], segments[i + 2]];
    if (!led(parent)) continue;
    const parentIs = globMatcher(parent);
    const childIs = globMatcher(child);
    if (parentIs(CONFIG_PARENT) && childIs(CONFIG_FOLDER_NAME)) {
      if (child !== '*' || (below !== undefined && below !== CONFIG_FILE)) return true;
    }
    if (parentIs(CLAUDE_FOLDER) && led(child) && childIs(CREDENTIALS_FILE)) return true;
  }
  return false;
}

const everyDotLed = (): boolean => true;

// Where `*` matches a leading dot, through an option the command sets (`dots`) or a `D` qualifier, every segment counts
// as dot-led. A word with a qualifier is read as written and with the separators in its qualifiers dropped.
function globNamesKey(word: string, dots: boolean): boolean {
  const qualified = dotQualified(word);
  if (qualified === null) return globPathNamesKey(word, dots ? everyDotLed : dotLed);
  return globPathNamesKey(word, everyDotLed) || (qualified !== word && globPathNamesKey(qualified, everyDotLed));
}

// A command's glob words, each once, though one recurs across its readings and forms, and whether the command sets an
// option that lets `*` match a leading dot. They are judged once every form has been read, since an option set in one
// form counts for a word read in another.
type Globs = { words: Set<string>; dots: boolean };

function gather(globs: Globs, lower: string): void {
  for (const word of globWords(lower)) globs.words.add(word);
  globs.dots ||= setsDotOption(lower);
}

// Names match in any spelling of the path: `~`, `$HOME`, `%USERPROFILE%`, `$env:…`, backslashes, a relative path. The
// text is read joined and as written: joining finds a name split for PowerShell, but it can glue a glob in the key
// folder to a later word that ends in config.json (`p* +config.json`) while the shell still reads the glob alone. Globs
// are gathered with backslashes dropped as escapes and, for Windows, as separators, where one also starts the name of
// the credentials file (`.\.credentials*`).
function namesKey(reading: Reading, globs: Globs): boolean {
  const named = nameForms(reading).some((form) => {
    const lower = fold(form);
    gather(globs, lower);
    return (
      KEY_NAMES.some((name) => lower.includes(name)) ||
      CREDENTIALS_STEM.test(lower) ||
      SHORT_NAME.test(lower) ||
      lower.split(WORD_BREAK).some((w) => w.includes(CONFIG_FOLDER_NAME) && !w.endsWith(CONFIG_FILE))
    );
  });
  if (named || !reading.text.includes('\\')) return named;
  return nameForms(reading, '/').some((form) => {
    const lower = fold(form);
    gather(globs, lower);
    return CREDENTIALS_STEM.test(lower);
  });
}

function isCommand(word: string, names: readonly string[]): boolean {
  const lower = word.toLowerCase();
  return names.some((name) => name.startsWith(lower));
}

// Whether an interactive flag sits among the flags between `security` and its command name. A command may name the
// binary many times, and a word such as `-/security` names it inside another's flags, so one pass keeps whether the
// words since the last binary are all flags.
function interactive(words: readonly string[]): boolean {
  let armed = false;
  for (const word of words) {
    if (armed && INTERACTIVE_FLAG.test(word)) return true;
    armed = (armed && word.startsWith('-')) || BINARY.test(fold(word));
  }
  return false;
}

function securityReason(plain: string): string | null {
  if (!fold(plain).includes('security')) return null;
  const words = plain.split(WORD_BREAK).filter((w) => w !== '');
  if (words.some((w) => isCommand(w, READ_COMMANDS)) && words.some((w) => READ_FLAG.test(w))) {
    return `studio guard: security find-*-password with -w or -g prints a keychain password. ${HINT}`;
  }
  if (words.some((w) => isCommand(w, DECRYPT_COMMANDS)) && words.some((w) => DECRYPT_FLAG.test(w))) {
    return `studio guard: security dump-keychain -d prints decrypted keychain items. ${HINT}`;
  }
  if (interactive(words)) {
    return `studio guard: interactive security (-i or -p) runs any keychain command, password reads included. ${HINT}`;
  }
  return null;
}

// The name rules first, then the keychain rules, over every reading of the command. Text nested too deep to read is
// refused unread.
export function keyReadReason(command: string): string | null {
  const all = readings(command);
  if (all === null) return KEY_REASON;
  const globs: Globs = { words: new Set(), dots: false };
  if (all.some((reading) => namesKey(reading, globs))) return KEY_REASON;
  for (const word of globs.words) if (globNamesKey(word, globs.dots)) return KEY_REASON;
  for (const reading of all) {
    for (const plain of keychainForms(reading)) {
      const reason = securityReason(plain);
      if (reason !== null) return reason;
    }
  }
  return null;
}

export type GuardDeps = { platform: NodeJS.Platform; home: string | null; realpath: (p: string) => Promise<string> };
type FileTool = 'Read' | 'Edit' | 'Write' | 'Grep';

// Only the fields that address a file are judged: content, old_string, new_string and Grep's pattern may name the key
// file, so source and docs can.
const ADDRESS_FIELDS: Record<FileTool, readonly string[]> = {
  Read: ['file_path'],
  Edit: ['file_path'],
  Write: ['file_path'],
  Grep: ['path', 'glob'],
};

// The key file or the credentials file by name, or anything in the key folder but config.json: a hard link or a copy of
// the key under another name included.
function pathNamesKey(path: string): boolean {
  const segments = path.split(SEPARATOR);
  const base = segments[segments.length - 1] ?? '';
  if (KEY_FILES.includes(fold(base))) return true;
  return base !== CONFIG_FILE && segments.some((s) => fold(s) === CONFIG_FOLDER_NAME);
}

// A path with no real path (a new file, a missing path) is judged as given, and the guard never throws over it.
function realOrNull(path: string, deps: GuardDeps): Promise<string | null> {
  return deps.realpath(path).catch(() => null);
}

function expandHome(path: string, deps: GuardDeps): string {
  if (deps.home === null) return path;
  return path === '~' ? deps.home : expandTilde(path, deps.home, deps.platform);
}

// A relative path names a file in the session's folder, not in the folder the hook runs in. Grep's glob is a pattern
// under its path, so it stays as given.
function located(value: string, field: string, deps: GuardDeps, cwd: string | undefined): string {
  const given = expandHome(value, deps);
  const p = pathFor(deps.platform);
  return cwd === undefined || field === 'glob' || p.isAbsolute(given) ? given : p.resolve(cwd, given);
}

// Whether `folder` is `path` or lies inside it, ignoring case where the file system does.
function holds(path: string, folder: string, platform: NodeJS.Platform): boolean {
  const p = pathFor(platform);
  const cased = (s: string): string => (platform === 'win32' || platform === 'darwin' ? fold(s) : s);
  const rel = p.relative(cased(path), cased(folder));
  return rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
}

// Grep on the key folder or a folder above it (`~/.config`, `~`) searches the key file, and Grep searches dotfiles, so
// one on Claude Code's folder or above it searches the credentials file; its subfolders hold none. A folder's real path
// counts too, for a home folder reached through a link.
async function holdsGuardedFolder(paths: readonly string[], deps: GuardDeps): Promise<boolean> {
  const { home } = deps;
  if (home === null) return false;
  const p = pathFor(deps.platform);
  const guarded = [p.join(home, ...CONFIG_FOLDER), p.join(home, CLAUDE_FOLDER)];
  const reals = await Promise.all(guarded.map((folder) => realOrNull(folder, deps)));
  const folders = [...guarded, ...reals.filter((real) => real !== null)];
  return paths.some((path) => folders.some((f) => holds(path, f, deps.platform)));
}

export async function fileReason(
  tool: FileTool,
  input: Readonly<Record<string, unknown>>,
  deps: GuardDeps,
  cwd?: string,
): Promise<string | null> {
  for (const field of ADDRESS_FIELDS[tool]) {
    const value = input[field];
    if (typeof value !== 'string') continue;
    const named = keyReadReason(value);
    if (named !== null) return named;
    const given = located(value, field, deps, cwd);
    const real = await realOrNull(given, deps);
    const paths = real === null ? [given] : [given, real];
    if (paths.some(pathNamesKey)) return KEY_REASON;
    if (tool === 'Grep' && field === 'path' && (await holdsGuardedFolder(paths, deps))) return KEY_REASON;
  }
  return null;
}

// Claude Code sends the whole tool call and the session's working folder.
const HookCall = z.object({
  tool_name: z.string().optional(),
  tool_input: z.record(z.string(), z.unknown()),
  cwd: z.string().optional(),
});
type HookCall = z.infer<typeof HookCall>;

// Every string in a value, at any depth.
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

async function callReason(
  { tool_name: tool, tool_input: input, cwd }: HookCall,
  deps: GuardDeps,
): Promise<string | null> {
  switch (tool) {
    case 'Bash':
    case 'Monitor':
      return typeof input.command === 'string' ? keyReadReason(input.command) : null;
    case 'Read':
    case 'Edit':
    case 'Write':
      return fileReason(tool, input, deps, cwd);
    case 'Grep':
      // Without a path Grep searches the session's working folder, and a path that is not a string counts as none.
      return fileReason(
        tool,
        typeof input.path !== 'string' && cwd !== undefined ? { ...input, path: cwd } : input,
        deps,
        cwd,
      );
    default: {
      // A tool whose field names are not recorded (PowerShell): every string in its input.
      const reasons = strings(input).map(keyReadReason);
      return reasons.find((r) => r !== null) ?? null;
    }
  }
}

// An empty stdout lets the call through, as does input with nothing to judge (not JSON, no tool input). A throw while
// judging (a stack overflow over a deeply nested input) refuses the call: a hook that fails would let it through.
export async function guardOutput(input: string, deps: GuardDeps): Promise<string> {
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    return '';
  }
  const call = HookCall.safeParse(raw);
  const reason = call.success ? await callReason(call.data, deps).catch(() => UNJUDGED_REASON) : null;
  if (reason === null) return '';
  const hookSpecificOutput = {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  };
  return `${JSON.stringify({ hookSpecificOutput })}\n`;
}

// os.homedir throws for a user the system has no home folder for. Only the Grep ancestor rule needs the home folder,
// so the other rules still run, and a hook that fails would let every call through with an error notice.
function hostHome(): string | null {
  try {
    return userHome(process.env);
  } catch {
    return null;
  }
}

// Runs through the PreToolUse hook on every Bash, PowerShell, Monitor and Grep call, and on a Read, Edit or Write whose
// path looks like the key; a deny is that JSON on stdout with exit 0. The promise realpath is the native one.
export async function run(): Promise<void> {
  const deps: GuardDeps = { platform: process.platform, home: hostHome(), realpath };
  process.stdout.write(await guardOutput(await text(process.stdin), deps));
}
