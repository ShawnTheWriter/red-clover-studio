// ffprobe wrapper. Every duration used for timeline math comes from here —
// never from a model's requested duration or a guess. fal's advertised clip
// length and the file it actually returns are not guaranteed identical, and
// building an export off the requested number rather than the real one is how
// a cut drifts out of sync with its own audio.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

let available = null;
export async function ffprobeAvailable() {
  if (available != null) return available;
  try { await run("ffprobe", ["-version"], { timeout: 5000 }); available = true; }
  catch { available = false; }
  return available;
}

// Returns { durationSec, fps, width, height, hasAudio } for a real media file.
// Throws with a clear message if ffprobe is missing or the file can't be read
// — callers must not silently substitute a fake duration on failure.
export async function probe(absPath) {
  if (!(await ffprobeAvailable())) {
    throw new Error("ffprobe not found — install ffmpeg (e.g. `brew install ffmpeg`) to measure real clip durations");
  }
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    absPath,
  ], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 });

  const data = JSON.parse(stdout);
  const vStream = (data.streams || []).find((s) => s.codec_type === "video");
  const aStream = (data.streams || []).find((s) => s.codec_type === "audio");
  const durationSec = Number(data.format?.duration ?? vStream?.duration);
  // A file with no measurable duration is a failure, not a zero-length clip.
  // Returning 0 here made clipDurationSec() report 0, which silently dropped a
  // paid-for take out of every export while reporting success.
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`ffprobe could not measure a duration for ${absPath} — the file may be truncated or not a media file`);
  }

  // avg_frame_rate first: r_frame_rate is the timebase tick rate, which on an
  // elementary stream can be double the real frame rate.
  let fps = null;
  for (const rate of [vStream?.avg_frame_rate, vStream?.r_frame_rate]) {
    if (!rate) continue;
    const [n, d] = rate.split("/").map(Number);
    if (d && Number.isFinite(n / d) && n / d > 0) { fps = n / d; break; }
  }

  return {
    durationSec,
    fps: fps || null,
    width: vStream?.width || null,
    height: vStream?.height || null,
    hasAudio: !!aStream,
  };
}
