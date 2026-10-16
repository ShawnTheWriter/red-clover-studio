// Local ffmpeg work around an upscale take: cut the part to send, and make the
// result match its source afterwards.
//
// Why the second part exists (Shawn's side-by-side, 2026-10-16): SeedVR2 hands
// back the same number of frames at 23 fps for a 24 fps source (the take runs
// 4% slow), at 1088x1936 for a 1080x1920 job, and without the source's sound.
// A take that does not line up with the others breaks the cut, so every
// upscale is conformed: same frame count and frame rate, exact target size,
// source audio kept. If this fails the raw upscale is kept (the money is
// already spent) and the take says so.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { probe } from "./ffprobe.js";
import { upscaleOutputSize } from "./rates.js";

const run = promisify(execFile);
const tmpName = (ext) => path.join(os.tmpdir(), `rcs_up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);

// A copy of src holding just the kept spans ([{ inSec, outSec }], in order),
// re-encoded at high quality so the cuts are frame-accurate and the upscaler
// sees no extra loss. Several spans are joined into one continuous clip, with
// the take's sound cut the same way. Returns a temp path the caller deletes.
export async function trimmedCopy(srcAbs, spans) {
  const out = tmpName(".mp4");
  const list = (Array.isArray(spans) ? spans : []).filter((s) => s && s.outSec > s.inSec);
  if (!list.length) throw new Error("no span to cut");
  const enc = ["-c:v", "libx264", "-crf", "12", "-preset", "fast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k"];
  if (list.length === 1) {
    const [s] = list;
    const args = ["-hide_banner", "-loglevel", "error", "-y"];
    if (s.inSec > 0) args.push("-ss", String(s.inSec));
    args.push("-i", srcAbs, "-t", String(Math.max(0.1, s.outSec - s.inSec)), ...enc, out);
    await run("ffmpeg", args, { timeout: 120000 });
    return out;
  }
  const hasAudio = (await probe(srcAbs)).hasAudio;
  const parts = [], labels = [];
  list.forEach((s, k) => {
    parts.push(`[0:v]trim=start=${s.inSec}:end=${s.outSec},setpts=PTS-STARTPTS[v${k}]`);
    labels.push(`[v${k}]`);
    if (hasAudio) {
      parts.push(`[0:a]atrim=start=${s.inSec}:end=${s.outSec},asetpts=PTS-STARTPTS[a${k}]`);
      labels.push(`[a${k}]`);
    }
  });
  parts.push(`${labels.join("")}concat=n=${list.length}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? "[a]" : ""}`);
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", srcAbs, "-filter_complex", parts.join(";"), "-map", "[v]"];
  if (hasAudio) args.push("-map", "[a]");
  args.push(...enc, out);
  await run("ffmpeg", args, { timeout: 5 * 60 * 1000 });
  return out;
}

// Conform `upscaledAbs` (in place) to its source take. Returns what changed.
// `srcAbs` is the file that was SENT (the take itself, or the trimmed copy cut from it), so its
// frame rate, shape and sound are exactly what the result must match.
export async function normalizeUpscaled(upscaledAbs, { srcAbs, target = "1080p" }) {
  const src = await probe(srcAbs);
  const up = await probe(upscaledAbs);
  const want = upscaleOutputSize(src.width || up.width, src.height || up.height, target);
  const fps = src.fps || 24;
  const fpsOff = !up.fps || Math.abs(up.fps - fps) > 0.01;
  const sizeOff = up.width !== want.width || up.height !== want.height;
  const addAudio = src.hasAudio && !up.hasAudio;
  const changed = { fps: fpsOff, size: sizeOff, audio: addAudio };
  if (!fpsOff && !sizeOff && !addAudio) return { changed, ...changed, none: true };

  const tmp = upscaledAbs.replace(/\.mp4$/i, "") + ".conform.mp4";
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", upscaledAbs];
  if (addAudio) args.push("-i", srcAbs);
  const vf = [];
  // PTS from the frame number: exactly the same frame count at the source's
  // rate. (Scaling the timestamps by a ratio drifted by a frame or two.)
  if (fpsOff) vf.push(`setpts=N/(${fps}*TB)`);
  if (sizeOff) vf.push(`scale=${want.width}:${want.height}:flags=lanczos`);
  args.push("-map", "0:v:0");
  if (addAudio) args.push("-map", "1:a:0?");
  else if (up.hasAudio) args.push("-map", "0:a:0?");
  if (vf.length) args.push("-vf", vf.join(","));
  args.push("-r", String(fps), "-c:v", "libx264", "-crf", "14", "-preset", "slow", "-pix_fmt", "yuv420p");
  args.push("-c:a", "aac", "-b:a", "192k", "-shortest", tmp);
  await run("ffmpeg", args, { timeout: 15 * 60 * 1000 });
  await fs.rename(tmp, upscaledAbs);
  return { changed, ...changed, none: false };
}
