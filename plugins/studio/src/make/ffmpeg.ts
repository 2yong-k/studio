import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const STDERR_TAIL_BYTES = 2048;
// The working folder ffmpeg and ffprobe start in; every path they get is absolute, so it changes nothing they read or
// write. Windows runs a same-named program from the working folder first; the plugin folder holds none.
export const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));

// ffmpeg writes progress to stderr for the whole encode, so only a rolling tail is kept; a
// buffering exec (execFile's maxBuffer) would kill a long encode.
export function runFfmpeg(args: readonly string[], opts: { stdin?: Readable } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-y', ...args], {
      cwd: PLUGIN_DIR,
      stdio: [opts.stdin ? 'pipe' : 'ignore', 'ignore', 'pipe'],
    });
    let tail = Buffer.alloc(0);
    let sourceError: Error | null = null;
    child.stderr?.on('data', (chunk: Buffer) => {
      tail = Buffer.concat([tail, chunk]).subarray(-STDERR_TAIL_BYTES);
    });
    if (opts.stdin && child.stdin) {
      // A child that exits before reading all input closes the pipe; the exit code reports it.
      child.stdin.on('error', () => {});
      // A failing frame source would otherwise be an unhandled 'error' event. The child is killed, and the
      // rejection waits for its close so the caller's cleanup cannot race a file ffmpeg is still writing.
      opts.stdin.on('error', (e: Error) => {
        sourceError ??= e;
        // Once ffmpeg has started, one SIGTERM does not wake it from a blocking read of the pipe; EOF does.
        child.stdin?.destroy();
        child.kill();
      });
      opts.stdin.pipe(child.stdin);
    }
    child.on('error', reject);
    child.on('close', (code, signal) => {
      // A paused source (a generator waiting for the pipe to drain) would otherwise never finish.
      opts.stdin?.destroy();
      if (sourceError !== null) {
        reject(sourceError);
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const how = code === null ? `was killed by ${signal ?? 'a signal'}` : `exited with code ${code}`;
      reject(new Error(`ffmpeg ${how}: ${tail.toString('utf8').trim()}`));
    });
  });
}
