import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { itemPath, validName } from './library.js';

const run = promisify(execFile);
const TMP = join(process.cwd(), 'data', 'frames');

// Frozen-frame extraction, server-side only — displays never need a
// decoder beyond playback. ffmpeg resolves in order:
//   FFMPEG env → ffmpeg-static bundle → PATH.
// Missing ffmpeg degrades to a clear 503, not a crash.

let ffmpegPath;
function ffmpeg() {
  if (ffmpegPath !== undefined) return ffmpegPath;
  ffmpegPath = process.env.FFMPEG || null;
  if (!ffmpegPath) {
    try {
      // ffmpeg-static exports the platform binary path itself.
      ffmpegPath = createRequire(import.meta.url)('ffmpeg-static');
    } catch { ffmpegPath = 'ffmpeg'; }
  }
  return ffmpegPath;
}

export async function ffmpegAvailable() {
  try {
    await run(ffmpeg(), ['-version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// Extract one frame at `seconds` from a library video. Returns { buf, mime }.
export async function extractFrame(name, seconds) {
  if (!validName(name)) throw new Error('invalid name');
  const src = itemPath(name);
  const ext = name.toLowerCase();
  if (!/\.(mp4|mkv|avi|mov|webm|m4v|mpg|mpeg|ts)$/.test(ext)) {
    throw new Error('not a video');
  }
  mkdirSync(TMP, { recursive: true });
  const out = join(TMP, `${randomBytes(6).toString('hex')}.jpg`);
  const t = Math.min(Math.max(Number(seconds) || 0, 0), 86400);
  try {
    // -ss before -i seeks by keyframe then decodes forward — fast and
    // accurate enough for a still; -frames:v 1 caps at a single image.
    await run(ffmpeg(), [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(t), '-i', src,
      '-frames:v', '1', '-q:v', '3', '-y', out,
    ], { timeout: 30_000 });
    return { buf: readFileSync(out), mime: 'image/jpeg' };
  } finally {
    rmSync(out, { force: true });
  }
}
