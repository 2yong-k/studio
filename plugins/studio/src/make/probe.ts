import { execFile } from 'node:child_process';
import { z } from 'zod';
import { PLUGIN_DIR } from './ffmpeg.ts';

export type ProbeInfo = {
  format: string;
  width: number;
  height: number;
  durationMs: number | null;
  videoDurationMs: number | null;
  audioDurationMs: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
};

// Tool output, not one of our files: unknown fields are expected and ignored.
const FfprobeOutput = z.object({
  format: z.object({ format_name: z.string(), duration: z.string().optional() }),
  streams: z.array(
    z.object({
      codec_type: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      duration: z.string().optional(),
    }),
  ),
});

const DECIMAL = /^\d+(\.\d+)?$/;

function run(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { cwd: PLUGIN_DIR },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        // A spawn failure (no binary) has a string code; a failed probe has the exit code.
        if (typeof error.code !== 'number') reject(error);
        else reject(new Error(`ffprobe exited with code ${error.code}: ${stderr.trim().slice(-2048)}`));
      },
    );
  });
}

function parseOutput(stdout: string): z.infer<typeof FfprobeOutput> {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error('ffprobe printed output that is not JSON');
  }
  const parsed = FfprobeOutput.safeParse(json);
  if (!parsed.success) throw new Error(`ffprobe output is malformed: ${parsed.error.message}`);
  return parsed.data;
}

function toMs(duration: string | undefined): number | null {
  if (duration === undefined || !DECIMAL.test(duration)) return null;
  const seconds = Number(duration);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}

export async function probe(file: string): Promise<ProbeInfo> {
  const { format, streams } = parseOutput(await run(file));
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  return {
    format: format.format_name,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    durationMs: toMs(format.duration),
    videoDurationMs: toMs(video?.duration),
    audioDurationMs: toMs(audio?.duration),
    hasAudio: audio !== undefined,
    hasVideo: video !== undefined,
  };
}
