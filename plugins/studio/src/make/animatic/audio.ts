import { runFfmpeg } from '../ffmpeg.ts';
import { atomically } from '../files.ts';

const SAMPLE_RATE = 48_000;
// Quiet enough that the speech meter (-35 dB) does not take the model-sound stand-in for a voice.
const ROOM_AMPLITUDE = 0.02;

// Times are on the whole film's clock; a piece is cut at `untilMs`.
export type AudioPiece =
  | { kind: 'voice'; file: string; atMs: number; untilMs: number }
  | { kind: 'room'; atMs: number; untilMs: number };

const seconds = (ms: number): string => (ms / 1000).toFixed(3);
const samples = (ms: number): number => Math.round((ms * SAMPLE_RATE) / 1000);
const MONO = `aresample=${SAMPLE_RATE},aformat=channel_layouts=mono`;

// A piece is shifted by samples, not ms, so a delay never rounds to a different sample than the cut.
function pieceFilter(piece: AudioPiece, source: string, out: string): string {
  const span = Math.max(0, piece.untilMs - piece.atMs);
  const cut = `atrim=duration=${seconds(span)},asetpts=PTS-STARTPTS`;
  return `${source}${MONO},${cut},adelay=${samples(piece.atMs)}S:all=1[${out}]`;
}

// `amix normalize=0` keeps each piece at its own level; the silent base fixes the length at `totalMs`.
export async function mixPreviewAudio(
  pieces: readonly AudioPiece[],
  music: { file: string; gainDb: number } | null,
  totalMs: number,
  out: string,
): Promise<void> {
  const total = seconds(totalMs);
  // A file's input index is its place in this list.
  const files: string[] = [];
  const parts = [`anullsrc=r=${SAMPLE_RATE}:cl=mono:d=${total}[s]`];
  const labels = ['[s]'];
  for (const [i, piece] of pieces.entries()) {
    // anoisesrc reads a zero duration as endless, so an empty piece must never reach the graph.
    if (piece.untilMs <= piece.atMs) continue;
    if (piece.kind === 'voice') {
      parts.push(pieceFilter(piece, `[${files.length}:a]`, `p${i}`));
      files.push(piece.file);
    } else {
      const noise = `anoisesrc=color=brown:amplitude=${ROOM_AMPLITUDE}:sample_rate=${SAMPLE_RATE}:duration=${seconds(piece.untilMs - piece.atMs)}`;
      parts.push(pieceFilter(piece, `${noise},`, `p${i}`));
    }
    labels.push(`[p${i}]`);
  }
  if (music !== null) {
    parts.push(
      `[${files.length}:a]volume=${music.gainDb}dB,${MONO},apad=whole_dur=${total},atrim=duration=${total}[m]`,
    );
    files.push(music.file);
    labels.push('[m]');
  }
  parts.push(
    `${labels.join('')}amix=inputs=${labels.length}:duration=first:normalize=0,apad=whole_dur=${total},atrim=duration=${total}[a]`,
  );
  await atomically(out, (tmp) =>
    runFfmpeg([
      ...files.flatMap((f) => ['-i', f]),
      '-filter_complex',
      parts.join(';'),
      '-map',
      '[a]',
      '-c:a',
      'pcm_s16le',
      '-ar',
      String(SAMPLE_RATE),
      '-ac',
      '1',
      '-f',
      'wav',
      tmp,
    ]),
  );
}
