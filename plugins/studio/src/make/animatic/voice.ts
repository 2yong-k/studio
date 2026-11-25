import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { promisify } from 'node:util';
import { type Env, type Exec, systemRoot, withoutPluginOptions } from '../../config.ts';
import { StudioError } from '../../errors.ts';
import { type Speech, tokens, type VoiceKind } from '../../works/index.ts';
import { runFfmpeg } from '../ffmpeg.ts';

export type VoiceLang = 'ko' | 'en';

// The language is the line's, so each word of a line is read with the line's voice; without it the text decides.
export type Voice = (text: string, kind: VoiceKind, out: string, lang?: VoiceLang) => Promise<void>;

export const voiceLang = (text: string): VoiceLang => (/\p{Script=Hangul}/u.test(text) ? 'ko' : 'en');

export type VoicePick = { base: string; locale: string };

// The macOS voices `say` uses, for previews only (Windows and Linux pick theirs by language and gender). Real names
// carry a tail in the system's language (`Reed (Korean (South Korea))`), so a voice is matched by its base name and
// locale.
export const VOICES: Readonly<Record<VoiceLang, Readonly<Record<VoiceKind, VoicePick>>>> = {
  ko: { male: { base: 'Reed', locale: 'ko_KR' }, female: { base: 'Yuna', locale: 'ko_KR' } },
  en: { male: { base: 'Reed', locale: 'en_US' }, female: { base: 'Samantha', locale: 'en_US' } },
};

const SAY_RATE = 175;
const run = promisify(execFile);

const VOICE_LISTING = /^(.+?)\s+([a-z]{2,3}_\w+)\s+#/u;

export type EngineName = 'say' | 'sapi' | 'espeak-ng';
export type Installed = { name: string; locale: string; gender?: 'male' | 'female' };
type Choice = { found: Installed; degraded: boolean };

// `wanted` names the voice an engine looks for by name, so a missing one can be told to the user; an engine that
// chooses by culture and gender leaves it out.
export type Engine = {
  name: EngineName;
  readWords: boolean;
  wanted?(lang: VoiceLang, kind: VoiceKind): { voice: string; locale: string };
  list(): Promise<Installed[]>;
  choose(installed: readonly Installed[], lang: VoiceLang, kind: VoiceKind): Choice | null;
  speak(found: Installed, text: string, out: string, lang: VoiceLang): Promise<void>;
};

export type VoiceNotes = {
  missing: { lang: VoiceLang; kind: VoiceKind; reason: string }[];
  degraded: { lang: VoiceLang; kind: VoiceKind; used: string }[];
};

export type VoiceSource = {
  voice: Voice;
  readWords: boolean;
  report(): { engine: EngineName | 'none' } & VoiceNotes;
};

function parseVoiceListing(stdout: string): Installed[] {
  const found: Installed[] = [];
  for (const line of stdout.split('\n')) {
    const m = VOICE_LISTING.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) found.push({ name: m[1], locale: m[2] });
  }
  return found;
}

const isPick = (v: Installed, pick: VoicePick): boolean =>
  v.locale === pick.locale && (v.name === pick.base || v.name.startsWith(`${pick.base} (`));

const reasonOf = (e: unknown): string => {
  const stderr = e instanceof Error && 'stderr' in e ? String(e.stderr).trim() : '';
  if (stderr !== '') return stderr;
  return e instanceof Error ? e.message : String(e);
};

// A program that cannot be started: a spawn that found no such file, or an engine that knows it has no program to run.
class CannotStart extends Error {
  override readonly name = 'CannotStart';
}

const cannotStart = (e: unknown): boolean =>
  e instanceof CannotStart || (e instanceof Error && 'code' in e && e.code === 'ENOENT');

// `say -v <unknown>` exits 0 and reads in the default voice, so an uninstalled voice has to be found in the listing.
export function sayEngine(picks: typeof VOICES = VOICES, bin = 'say'): Engine {
  return {
    name: 'say',
    readWords: true,
    wanted: (lang, kind) => ({ voice: picks[lang][kind].base, locale: picks[lang][kind].locale }),
    list: async () => parseVoiceListing((await run(bin, ['-v', '?'])).stdout),
    choose: (installed, lang, kind) => {
      const found = installed.find((v) => isPick(v, picks[lang][kind]));
      return found === undefined ? null : { found, degraded: false };
    },
    // `--` keeps a line that starts with '-' from being read as an option.
    speak: async (found, text, out) => {
      await run(bin, ['-v', found.name, '-r', String(SAY_RATE), '-o', out, '--', text]);
    },
  };
}

// Rejects on a non-zero exit, a failed start or the timeout.
export type ToolRun = (
  cmd: string,
  args: readonly string[],
  opts: { env: Readonly<Record<string, string>>; timeoutMs: number },
) => Promise<{ stdout: string }>;

export const runTool: ToolRun = async (cmd, args, { env, timeoutMs }) => ({
  stdout: (await run(cmd, args, { env, timeout: timeoutMs })).stdout,
});

// The only code PowerShell runs. Every value travels in an env var, so no text of a line is ever quoted into code.
export const SAPI_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  'try {',
  "  if ($env:STUDIO_TTS_MODE -eq 'speak') {",
  '    $s.SelectVoice($env:STUDIO_TTS_VOICE)',
  '    $s.Rate = 0',
  '    $s.SetOutputToWaveFile($env:STUDIO_TTS_OUT)',
  '    $s.Speak($env:STUDIO_TTS_TEXT)',
  '  } else {',
  '    foreach ($v in $s.GetInstalledVoices()) {',
  '      $i = $v.VoiceInfo',
  "      [Console]::Out.WriteLine(($i.Name, $i.Culture.Name, $i.Gender, $v.Enabled) -join '|')",
  '    }',
  '  }',
  '} finally { $s.Dispose() }',
].join('\n');

const SAPI_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  Buffer.from(SAPI_SCRIPT, 'utf16le').toString('base64'),
] as const;
const SAPI_TIMEOUT_MS = 60_000;
const SAPI_GENDERS = new Map<string | undefined, VoiceKind>([
  ['Male', 'male'],
  ['Female', 'female'],
]);

const powershellIn = (root: string): string =>
  win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// `name|culture|gender|enabled` per line. Windows ends each line with CRLF and may start with a byte order mark.
export function parseSapiListing(stdout: string): Installed[] {
  const found: Installed[] = [];
  for (const line of stdout.replace(/^\ufeff/, '').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const [name, locale, gender, enabled, ...rest] = line.split('|').map((f) => f.trim());
    if (name === undefined || locale === undefined || enabled !== 'True' || rest.length > 0) continue;
    const kind = SAPI_GENDERS.get(gender);
    found.push(kind === undefined ? { name, locale } : { name, locale, gender: kind });
  }
  return found;
}

// `ko` takes any Korean culture. `en` takes en-US while it has any voice, so every English line sounds alike; only
// without one does the first other English culture listed serve.
function ofLanguage(installed: readonly Installed[], lang: VoiceLang): Installed[] {
  if (lang === 'ko') return installed.filter((v) => v.locale.startsWith('ko-'));
  const culture = installed.some((v) => v.locale === 'en-US')
    ? 'en-US'
    : installed.find((v) => v.locale.startsWith('en-'))?.locale;
  return installed.filter((v) => v.locale === culture);
}

// The wanted gender first; otherwise any voice of that culture reads the line, reported as degraded.
function chooseByCulture(installed: readonly Installed[], lang: VoiceLang, kind: VoiceKind): Choice | null {
  const fitting = ofLanguage(installed, lang);
  const found = fitting.find((v) => v.gender === kind);
  if (found !== undefined) return { found, degraded: false };
  const any = fitting[0];
  return any === undefined ? null : { found: any, degraded: true };
}

// PowerShell 5.1 started with -EncodedCommand writes an error to a redirected stderr as CLIXML: `#< CLIXML`, then an
// <Objs> blob whose <S S="Error"> elements carry the text, with `_xHHHH_` escapes for characters and XML entities.
const CLIXML_ERROR = /<S S="Error">([\s\S]*?)<\/S>/;
const CLIXML_ESCAPE = /_x([0-9A-Fa-f]{4})_|&(lt|gt|amp|quot|apos);/g;
const XML_ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

const firstLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '');

function stderrReason(stderr: string): string | undefined {
  const first = firstLine(stderr);
  if (first !== '#< CLIXML') return first;
  const error = CLIXML_ERROR.exec(stderr)?.[1];
  if (error === undefined) return undefined;
  return firstLine(
    error.replace(CLIXML_ESCAPE, (_, hex: string | undefined, entity: string | undefined) =>
      hex === undefined ? (XML_ENTITIES[entity ?? ''] ?? '') : String.fromCharCode(Number.parseInt(hex, 16)),
    ),
  );
}

// execFile's own message repeats the command line (the encoded script, or the text of a line), so a run that failed is
// told in a few words. A program that never started keeps its error, so the engine is still reported as none.
function shortFailure(program: string, timeoutMs: number, e: unknown): unknown {
  if (!(e instanceof Error)) return e;
  if ('killed' in e && e.killed === true) return new Error(`${program} timed out after ${timeoutMs / 1000} s`);
  if ('code' in e && typeof e.code === 'number') {
    const said = stderrReason('stderr' in e ? String(e.stderr) : '');
    return new Error(`${program} exited with code ${e.code}${said === undefined ? '' : `: ${said}`}`);
  }
  if ('signal' in e && typeof e.signal === 'string') return new Error(`${program} ended by ${e.signal}`);
  return e;
}

// Windows' own SAPI5 voices, chosen by culture and gender, never by name: the names differ between Windows editions
// and display languages.
export function sapiEngine(powershell: string, env: Env, run: ToolRun = runTool): Engine {
  const call = async (vars: Readonly<Record<string, string>>): Promise<string> => {
    const childEnv = { ...withoutPluginOptions(env), ...vars };
    try {
      return (await run(powershell, SAPI_ARGS, { env: childEnv, timeoutMs: SAPI_TIMEOUT_MS })).stdout;
    } catch (e) {
      throw shortFailure('powershell', SAPI_TIMEOUT_MS, e);
    }
  };
  return {
    name: 'sapi',
    readWords: false,
    list: async () => parseSapiListing(await call({ STUDIO_TTS_MODE: 'list' })),
    choose: chooseByCulture,
    speak: async (found, text, out) => {
      await call({
        STUDIO_TTS_MODE: 'speak',
        STUDIO_TTS_TEXT: text,
        STUDIO_TTS_OUT: out,
        STUDIO_TTS_VOICE: found.name,
      });
    },
  };
}

// Lists once; a failed listing is dropped so the next read lists again. Every failure of a read is VOICE_MISSING and
// is noted for its (language, kind), which is what the preview reports.
export function engineVoice(engine: Engine): VoiceSource {
  let listing: Promise<Installed[]> | undefined;
  let unstartable = false;
  const notes: VoiceNotes = { missing: [], degraded: [] };
  const installed = (): Promise<Installed[]> => {
    if (listing === undefined) {
      const attempt: Promise<Installed[]> = engine.list().then(
        (found) => {
          unstartable = false;
          return found;
        },
        (e: unknown) => {
          if (listing === attempt) listing = undefined;
          unstartable = cannotStart(e);
          throw e;
        },
      );
      listing = attempt;
    }
    return listing;
  };
  const voice: Voice = async (text, kind, out, lang) => {
    const want = lang ?? voiceLang(text);
    const missing = (why: string): StudioError => {
      if (!notes.missing.some((n) => n.lang === want && n.kind === kind)) {
        notes.missing.push({ lang: want, kind, reason: why });
      }
      const named = engine.wanted?.(want, kind);
      if (named === undefined) {
        return new StudioError('VOICE_MISSING', `the ${want} ${kind} voice cannot be used: ${why}`, {
          lang: want,
          kind,
        });
      }
      return new StudioError('VOICE_MISSING', `the voice "${named.voice}" (${named.locale}) cannot be used: ${why}`, {
        voice: named.voice,
        locale: named.locale,
      });
    };
    try {
      const choice = engine.choose(await installed(), want, kind);
      if (choice === null) throw missing('it is not installed');
      if (choice.degraded && !notes.degraded.some((n) => n.lang === want && n.kind === kind)) {
        notes.degraded.push({ lang: want, kind, used: choice.found.name });
      }
      await engine.speak(choice.found, text, out, want);
    } catch (e) {
      throw e instanceof StudioError ? e : missing(reasonOf(e));
    }
  };
  return {
    voice,
    readWords: engine.readWords,
    report: () => ({
      engine: unstartable ? 'none' : engine.name,
      missing: [...notes.missing],
      degraded: [...notes.degraded],
    }),
  };
}

const ESPEAK_TIMEOUT_MS = 60_000;
const ESPEAK_RATE = 175;
const ESPEAK_VARIANTS: Readonly<Record<VoiceKind, string>> = { male: 'm3', female: 'f3' };

// The `Language` column (the second) of `espeak-ng --voices`. The header row has no number in its first column.
export function parseEspeakVoices(stdout: string): Installed[] {
  const found: Installed[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [pty, language] = line.trim().split(/\s+/);
    if (pty === undefined || language === undefined || !/^\d+$/.test(pty)) continue;
    found.push({ name: language, locale: language });
  }
  return found;
}

const espeakLanguage = (v: Installed, lang: string): boolean => v.locale === lang || v.locale.startsWith(`${lang}-`);

// `ko` takes any Korean language, `en` takes en-us and then any other English one. The m3 and f3 variants give both
// kinds of voice in every language, so a choice is never degraded; the kind travels in `gender` to `speak`.
function chooseEspeak(installed: readonly Installed[], lang: VoiceLang, kind: VoiceKind): Choice | null {
  const fitting = installed.filter((v) => espeakLanguage(v, lang));
  const found = lang === 'en' ? (fitting.find((v) => v.locale === 'en-us') ?? fitting[0]) : fitting[0];
  return found === undefined ? null : { found: { ...found, gender: kind }, degraded: false };
}

// espeak-ng writes a WAV and needs no sound device.
export function espeakEngine(env: Env, run: ToolRun = runTool, bin = 'espeak-ng'): Engine {
  const call = async (args: readonly string[]): Promise<string> => {
    try {
      return (await run(bin, args, { env: withoutPluginOptions(env), timeoutMs: ESPEAK_TIMEOUT_MS })).stdout;
    } catch (e) {
      throw shortFailure('espeak-ng', ESPEAK_TIMEOUT_MS, e);
    }
  };
  return {
    name: 'espeak-ng',
    readWords: true,
    list: async () => parseEspeakVoices(await call(['--voices'])),
    choose: chooseEspeak,
    // `--` keeps a line that starts with '-' from being read as an option.
    speak: async (found, text, out) => {
      const variant = ESPEAK_VARIANTS[found.gender ?? 'female'];
      await call(['-b', '1', '-v', `${found.name}+${variant}`, '-s', String(ESPEAK_RATE), '-w', out, '--', text]);
    },
  };
}

// An engine whose program cannot be started: its listing fails as a missing program does, so the preview is silent
// and the engine is reported as none.
function unstartableEngine(reason: string): Engine {
  const fail = (): Promise<never> => Promise.reject(new CannotStart(reason));
  return { name: 'sapi', readWords: false, list: fail, choose: () => null, speak: fail };
}

function windowsEngine(env: Env, run: ToolRun = runTool): Engine {
  const root = systemRoot(env);
  return root.ok ? sapiEngine(powershellIn(root.root), env, run) : unstartableEngine(root.reason);
}

export function platformVoice(platform: NodeJS.Platform, env: Env): VoiceSource {
  if (platform === 'darwin') return engineVoice(sayEngine());
  if (platform === 'win32') return engineVoice(windowsEngine(env));
  return engineVoice(espeakEngine(env));
}

type Described = { ok: boolean; detail: string };

// A listing that fails is the result, never a rejection.
async function listingOf(
  exec: Exec,
  cmd: string,
  args: readonly string[],
  program: string,
): Promise<{ stdout: string } | Described> {
  try {
    const { stdout, code } = await exec(cmd, args);
    if (code !== 0) return { ok: false, detail: `listing the voices failed: ${program} exited with code ${code}` };
    return { stdout };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

async function describeSay(exec: Exec): Promise<Described> {
  const listing = await listingOf(exec, 'say', ['-v', '?'], 'say');
  if (!('stdout' in listing)) return listing;
  const installed = parseVoiceListing(listing.stdout);
  const wanted = Object.values(VOICES).flatMap((byKind) => Object.values(byKind));
  const missing = wanted.filter((pick) => !installed.some((v) => isPick(v, pick)));
  if (missing.length === 0) return { ok: true, detail: `all ${wanted.length} installed` };
  return { ok: false, detail: `missing: ${missing.map((p) => `${p.base} (${p.locale})`).join(', ')}` };
}

const SAPI_LANGUAGES = [
  { lang: 'en', culture: 'en-US', language: 'English' },
  { lang: 'ko', culture: 'ko-KR', language: 'Korean' },
] as const;
const KINDS: readonly VoiceKind[] = ['male', 'female'];

// Names the culture a language is read in, and what that culture lacks. A kind it lacks is read by the voice
// chooseByCulture falls back to, and Windows has no male Korean voice to install, so that gap still counts as ok.
function describeSapiLanguage(
  installed: readonly Installed[],
  { lang, culture, language }: (typeof SAPI_LANGUAGES)[number],
): Described {
  const fitting = ofLanguage(installed, lang);
  const reader = fitting[0];
  if (reader === undefined) {
    return { ok: false, detail: `${culture} missing (add the ${language} language pack to hear ${language} lines)` };
  }
  const lacking = KINDS.filter((kind) => !fitting.some((v) => v.gender === kind));
  if (lacking.length === 0) return { ok: true, detail: `${reader.locale} ok` };
  const by = reader.gender === undefined ? reader.name : `the ${reader.gender} voice`;
  const gap = `no ${lacking.join(' or ')} voice: ${lacking.join(' and ')} lines are read by ${by}`;
  return { ok: true, detail: `${reader.locale} ok (${gap})` };
}

// Lists through the engine a preview reads with, so the doctor gets its time limit and child env. A program that
// cannot start (no SystemRoot reads as one) is told as it is; any other failure is a failed listing.
async function describeSapi(env: Env, run: ToolRun): Promise<Described> {
  let installed: Installed[];
  try {
    installed = await windowsEngine(env, run).list();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: cannotStart(e) ? why : `listing the voices failed: ${why}` };
  }
  const languages = SAPI_LANGUAGES.map((l) => describeSapiLanguage(installed, l));
  return { ok: languages.every((l) => l.ok), detail: `sapi: ${languages.map((l) => l.detail).join(', ')}` };
}

const ESPEAK_LANGUAGES = [
  { lang: 'ko', label: 'ko' },
  { lang: 'en', label: 'en' },
] as const;

// Lists through the engine a preview reads with, like describeSapi. A missing program is the usual state of a machine
// that has not installed it, so it is told as optional.
async function describeEspeak(env: Env, run: ToolRun): Promise<Described> {
  let installed: Installed[];
  try {
    installed = await espeakEngine(env, run).list();
  } catch (e) {
    if (cannotStart(e)) return { ok: false, detail: 'espeak-ng not found (optional: install it to hear lines)' };
    return { ok: false, detail: `listing the voices failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const choices = ESPEAK_LANGUAGES.map((l) => chooseEspeak(installed, l.lang, 'male'));
  const missing = ESPEAK_LANGUAGES.filter((_, i) => choices[i] === null).map((l) => l.label);
  if (missing.length === 0) {
    const read = choices.flatMap((c) => (c === null ? [] : [c.found.locale]));
    return { ok: true, detail: `espeak-ng: ${read.join(' and ')} available` };
  }
  return { ok: false, detail: `espeak-ng: ${missing.join(' and ')} missing` };
}

const PREVIEW_STILL_WORKS = '; preview still works: those lines are previewed silently with estimated timing';

const describeOn = (platform: NodeJS.Platform, exec: Exec, env: Env, run: ToolRun): Promise<Described> => {
  if (platform === 'darwin') return describeSay(exec);
  if (platform === 'win32') return describeSapi(env, run);
  return describeEspeak(env, run);
};

// Never rejects: a listing that fails is the result. `say` is listed through `exec`, the other engines through `run`.
// A voice that is missing never stops a preview, so every failing row says what happens instead.
export async function describeVoices(
  platform: NodeJS.Platform,
  exec: Exec,
  env: Env,
  run: ToolRun = runTool,
): Promise<Described> {
  const described = await describeOn(platform, exec, env, run);
  return described.ok ? described : { ok: false, detail: `${described.detail}${PREVIEW_STILL_WORKS}` };
}

export const ENVELOPE_WINDOW_MS = 20;

const PCM_RATE = 16_000;
const SAMPLES_PER_WINDOW = (PCM_RATE * ENVELOPE_WINDOW_MS) / 1000;
const VOICED_LEVEL = 0.12;
const PEAK_SHARE = 0.7;

export type SpokenLine = {
  text: string;
  atMs: number;
  file: string | null;
  startMs: number;
  endMs: number;
  words: { bare: string; startMs: number }[];
  envelope: readonly number[];
};

type Measured = { envelope: number[]; firstVoiced: number; lastVoiced: number };

// ffmpeg's stdout is discarded by runFfmpeg, so the samples go through a file.
async function measure(file: string): Promise<Measured> {
  const pcm = `${file}.pcm`;
  try {
    await runFfmpeg(['-i', file, '-ac', '1', '-ar', String(PCM_RATE), '-f', 's16le', pcm]);
    const bytes = await readFile(pcm);
    const rms: number[] = [];
    for (let from = 0; from < bytes.length / 2; from += SAMPLES_PER_WINDOW) {
      const to = Math.min(from + SAMPLES_PER_WINDOW, Math.floor(bytes.length / 2));
      let sum = 0;
      for (let i = from; i < to; i++) sum += (bytes.readInt16LE(i * 2) / 32768) ** 2;
      rms.push(Math.sqrt(sum / (to - from)));
    }
    const peak = Math.max(0, ...rms);
    const envelope = rms.map((v) => (peak > 0 ? Math.min(1, v / (peak * PEAK_SHARE)) : 0));
    const firstVoiced = envelope.findIndex((v) => v > VOICED_LEVEL);
    // No loud window at all (silence) still counts as one window, so a silent word keeps its place.
    if (firstVoiced < 0) return { envelope, firstVoiced: 0, lastVoiced: 0 };
    return { envelope, firstVoiced, lastVoiced: envelope.findLastIndex((v) => v > VOICED_LEVEL) };
  } finally {
    await rm(pcm, { force: true });
  }
}

const windowsOf = (m: Measured): number => m.lastVoiced - m.firstVoiced + 1;

const MS_PER_UNIT: Readonly<Record<VoiceLang, number>> = { ko: 200, en: 250 };
const SENTENCE_PAUSE_MS = 350;
const CLAUSE_PAUSE_MS = 150;
const MIN_LINE_MS = 200;
const VOICED_SHARE = 0.7;
const VOICED_ESTIMATE = 0.8;
const TAIL_ESTIMATE = 0.25;
const SENTENCE_END = /[.!?\u2026\u3002]$/u;
const CLAUSE_END = /[,;:]$/u;

// A Hangul syllable is one unit; any other token with a letter or digit has one unit per group of vowels, and at
// least one; a token of symbols only has none.
export function unitsOf(token: string): number {
  const syllables = token.match(/[\uAC00-\uD7A3]/gu);
  if (syllables !== null) return syllables.length;
  if (!/[\p{L}\p{N}]/u.test(token)) return 0;
  return Math.max(1, token.toLowerCase().match(/[aeiouy]+/g)?.length ?? 0);
}

const pauseAfter = (raw: string): number => {
  if (SENTENCE_END.test(raw)) return SENTENCE_PAUSE_MS;
  return CLAUSE_END.test(raw) ? CLAUSE_PAUSE_MS : 0;
};

// A line timed from its text alone, for a machine with no voice to read it: the same shape as a read line, with no
// file. Pauses count only in a line that has a unit to say, so a line of symbols lasts the floor and is silent.
export function estimateLine(text: string, atMs: number, lang: VoiceLang): SpokenLine {
  const parts = tokens(text);
  const units = parts.map((t) => unitsOf(t.raw));
  const spoken = units.some((u) => u > 0);
  const unitMs = MS_PER_UNIT[lang];
  // Where each unit sounds, relative to the line start: its voiced head and quieter tail are told apart later.
  const sounding: number[] = [];
  const words: { bare: string; startMs: number }[] = [];
  let running = 0;
  let previous = Number.NEGATIVE_INFINITY;
  for (const [k, t] of parts.entries()) {
    const startMs = Math.max(atMs + running, previous + ENVELOPE_WINDOW_MS);
    words.push({ bare: t.bare, startMs });
    previous = startMs;
    for (let u = 0; u < (units[k] ?? 0); u++) sounding.push(running + u * unitMs);
    running += (units[k] ?? 0) * unitMs + (spoken ? pauseAfter(t.raw) : 0);
  }
  const endMs = atMs + Math.max(MIN_LINE_MS, running);
  const envelope = Array.from({ length: Math.ceil((endMs - atMs) / ENVELOPE_WINDOW_MS) }, () => 0);
  for (const from of sounding) {
    const first = Math.ceil(from / ENVELOPE_WINDOW_MS);
    for (let k = first; k < envelope.length && k * ENVELOPE_WINDOW_MS < from + unitMs; k++) {
      envelope[k] = (k * ENVELOPE_WINDOW_MS - from) / unitMs < VOICED_SHARE ? VOICED_ESTIMATE : TAIL_ESTIMATE;
    }
  }
  return { text, atMs, file: null, startMs: atMs, endMs, words, envelope };
}

// The whole line is read once for its sound span and each word once for its share of it: reading a word alone
// gives its length without the pauses a recognizer would have to find inside the full line. An engine that starts
// slowly (readWords false) shares the span by the units of each word instead. A machine with no voice for the line
// gets the estimate; any other failure stops the preview.
async function speakLine(
  text: string,
  atMs: number,
  kind: VoiceKind,
  base: string,
  voice: Voice,
  readWords: boolean,
): Promise<SpokenLine> {
  const file = `${base}.aiff`;
  const lang = voiceLang(text);
  try {
    await voice(text, kind, file, lang);
  } catch (e) {
    if (e instanceof StudioError && e.code === 'VOICE_MISSING') return estimateLine(text, atMs, lang);
    throw e;
  }
  const whole = await measure(file);
  const startMs = atMs + whole.firstVoiced * ENVELOPE_WINDOW_MS;
  const endMs = atMs + (whole.lastVoiced + 1) * ENVELOPE_WINDOW_MS;

  const parts = tokens(text);
  const lengths: number[] = [];
  for (const [k, t] of parts.entries()) {
    if (!readWords) {
      // A line of punctuation has no unit; one window keeps the share from dividing by zero.
      lengths.push(Math.max(1, unitsOf(t.raw)));
      continue;
    }
    const wordFile = `${base}-w${k}.aiff`;
    await voice(t.raw, kind, wordFile, lang);
    lengths.push(windowsOf(await measure(wordFile)));
  }
  const total = lengths.reduce((a, b) => a + b, 0);
  const words: { bare: string; startMs: number }[] = [];
  let before = 0;
  let previous = Number.NEGATIVE_INFINITY;
  for (const [k, t] of parts.entries()) {
    // Rounding must not let a short word share a start with its neighbour.
    const at = Math.max(startMs + Math.round((before / total) * (endMs - startMs)), previous + ENVELOPE_WINDOW_MS);
    words.push({ bare: t.bare, startMs: k === 0 ? startMs : at });
    previous = words[k]?.startMs ?? at;
    before += lengths[k] ?? 0;
  }
  return { text, atMs, file, startMs, endMs, words, envelope: whole.envelope };
}

export async function speak(speech: Speech, dir: string, voice: Voice, readWords = true): Promise<SpokenLine[]> {
  const spoken: SpokenLine[] = [];
  for (const [i, l] of speech.lines.entries()) {
    spoken.push(await speakLine(l.text, l.atMs, speech.voice, join(dir, `line-${i}`), voice, readWords));
  }
  return spoken;
}

export function mouthAt(lines: readonly SpokenLine[], tMs: number): number {
  let level = 0;
  for (const l of lines) {
    const k = Math.floor((tMs - l.atMs) / ENVELOPE_WINDOW_MS);
    level = Math.max(level, l.envelope[k] ?? 0);
  }
  return level;
}
