// Rational-time helpers shared by both exporters. Every duration and offset in
// this module is quantized to a WHOLE FRAME before it is written out.
//
// Why this matters: ffprobe returns a real duration like 5.184s. If that
// number is written into an edit file as a plain fraction (5184/1000s) it
// will not land on a frame boundary at 24fps (5.184 * 24 = 124.416 frames),
// and an NLE importing it has to round somewhere — silently, and not
// necessarily the way you'd want. Rounding to whole frames HERE, once, in one
// place both exporters share, means the number that gets written is the same
// number Resolve will actually use, not a number Resolve reinterprets.

export function secToFrames(sec, fps) {
  return Math.max(0, Math.round(sec * fps));
}

export function framesToSec(frames, fps) {
  return frames / fps;
}

// ffprobe reports NTSC rates as floats (30000/1001 arrives as
// 29.97002997002997), but FCPXML requires rational time as ONE INTEGER OVER
// ANOTHER. Interpolating the float produced "1/29.97002997002997s", which
// Resolve either rejects or silently re-rounds — precisely the outcome the
// quantization above exists to prevent. Recover the real timebase instead:
// 29.97 -> 30000/1001, 23.976 -> 24000/1001, 24 -> 24/1.
export function fpsRational(fps) {
  const f = Number(fps) || 24;
  const whole = Math.round(f);
  if (Math.abs(f - whole) < 1e-6) return { num: whole, den: 1 };
  const ntsc = Math.round((f * 1001) / 1000);
  if (Math.abs((ntsc * 1000) / 1001 - f) < 1e-6) return { num: ntsc * 1000, den: 1001 };
  return { num: Math.round(f * 1000), den: 1000 };
}

// "12/24s" style rational-time string, in frame units against the given fps —
// the form FCPXML expects for offsets/durations/starts. Both halves are always
// integers.
export function frameFraction(frames, fps) {
  const { num, den } = fpsRational(fps);
  return `${Math.round(frames) * den}/${num}s`;
}
