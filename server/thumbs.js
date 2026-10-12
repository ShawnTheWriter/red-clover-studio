// Thumbnail cache.
//
// Turnarounds and location plates are 2K masters — several megabytes each. A
// vault of thirty of them is unusable at full size. macOS ships `sips`, so
// resizing costs no dependency; thumbnails are cached OUTSIDE the project folder
// so Google Drive never syncs them.
//
// Video takes get a poster frame the same way, pulled with ffmpeg (already a
// hard dependency for ffprobe duration measurement — see ffprobe.js) so the
// Version tray can show what a take actually looks like without loading the
// whole clip.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const run = promisify(execFile);

export const CACHE = path.join(process.env.HOME, ".cache", "red-clover-studio", "thumbs");

const key = (abs, w, mtimeMs) =>
  crypto.createHash("sha1").update(`${abs}|${w}|${mtimeMs}`).digest("hex").slice(0, 20);

const IMG_RX = /\.(png|jpe?g|webp|gif|tiff?)$/i;
const VIDEO_RX = /\.(mp4|mov|webm|m4v)$/i;

// Returns a path to a cached JPEG no wider than `width`, or null when the
// source is neither an image sips can read nor a video ffmpeg can read.
// Falls back to the original on any failure — a missing thumbnail must never
// hide a real asset.
export async function thumbnail(abs, width = 480) {
  if (VIDEO_RX.test(abs)) return videoThumbnail(abs, width);
  if (!IMG_RX.test(abs)) return null;
  let st;
  try { st = await fs.stat(abs); } catch { return null; }

  const out = path.join(CACHE, `${key(abs, width, st.mtimeMs)}.jpg`);
  try { await fs.access(out); return out; } catch { /* miss */ }

  await fs.mkdir(CACHE, { recursive: true });
  try {
    await run("sips", ["-s", "format", "jpeg", "-Z", String(width), abs, "--out", out], { timeout: 20000 });
    return out;
  } catch {
    return null;
  }
}

// A frame a third of a second in (not frame 0, which on some encodes is
// black or a half-formed I-frame), scaled to `width` with aspect preserved.
async function videoThumbnail(abs, width) {
  let st;
  try { st = await fs.stat(abs); } catch { return null; }

  const out = path.join(CACHE, `${key(abs, width, st.mtimeMs)}.jpg`);
  try { await fs.access(out); return out; } catch { /* miss */ }

  await fs.mkdir(CACHE, { recursive: true });
  try {
    await run("ffmpeg", [
      "-ss", "0.3", "-i", abs,
      "-frames:v", "1",
      "-vf", `scale=${width}:-2`,
      "-y", out,
    ], { timeout: 20000 });
    await fs.access(out);
    return out;
  } catch {
    return null;
  }
}
