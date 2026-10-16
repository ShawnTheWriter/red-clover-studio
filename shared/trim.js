// A take's usable part: one in/out ("use 3–7 s") plus any number of CUT-OUTS
// inside it (Shawn, 2026-10-16: remove the cross-fade between 5.0 and 6.04 s of
// a 12 s take and keep the rest). Stored on the shot as
//   takeTrims[versionId] = { inSec, outSec, cuts?: [{ startSec, endSec }] }
// so every older reader that only knows inSec/outSec still sees a sane range.
// The KEPT SPANS are derived: the in/out range minus the cuts. The timeline
// makes one clip per kept span; an upscale cuts the spans out and joins them.
// Pure functions, shared by the server and the browser.

export const MIN_SPAN = 0.1;      // a kept piece shorter than this is dropped
const MIN_CUT = 0.04;             // a cut shorter than this is noise
const r3 = (x) => Math.round(x * 1000) / 1000;

// Sorted, clamped into the take, overlapping/touching cuts merged, tiny ones dropped.
export function normalizeCuts(cuts, dur) {
  const d = Number(dur) || 0;
  const list = (Array.isArray(cuts) ? cuts : [])
    .map((c) => ({ startSec: Number(c && c.startSec), endSec: Number(c && c.endSec) }))
    .filter((c) => Number.isFinite(c.startSec) && Number.isFinite(c.endSec) && c.endSec > c.startSec)
    .map((c) => (d > 0 ? { startSec: Math.max(0, Math.min(c.startSec, d)), endSec: Math.max(0, Math.min(c.endSec, d)) } : c))
    .filter((c) => c.endSec - c.startSec >= MIN_CUT)
    .sort((a, b) => a.startSec - b.startSec);
  const out = [];
  for (const c of list) {
    const last = out[out.length - 1];
    if (last && c.startSec <= last.endSec + 1e-6) last.endSec = Math.max(last.endSec, c.endSec);
    else out.push({ ...c });
  }
  return out.map((c) => ({ startSec: r3(c.startSec), endSec: r3(c.endSec) }));
}

// The pieces of a `dur`-second take that are kept: [{ inSec, outSec }], in order.
export function trimSpans({ inSec, outSec, cuts } = {}, dur) {
  const d = Number(dur) || 0;
  const a = Math.min(Math.max(0, Number(inSec) || 0), d);
  const b = outSec == null ? d : Math.min(Math.max(a, Number(outSec)), d);
  let spans = [{ inSec: a, outSec: b }];
  for (const c of normalizeCuts(cuts, d)) {
    const next = [];
    for (const s of spans) {
      if (c.endSec <= s.inSec || c.startSec >= s.outSec) { next.push(s); continue; }
      if (c.startSec > s.inSec) next.push({ inSec: s.inSec, outSec: c.startSec });
      if (c.endSec < s.outSec) next.push({ inSec: c.endSec, outSec: s.outSec });
    }
    spans = next;
  }
  return spans.filter((s) => s.outSec - s.inSec >= MIN_SPAN).map((s) => ({ inSec: r3(s.inSec), outSec: r3(s.outSec) }));
}

export const spansDuration = (spans) => r3((spans || []).reduce((t, s) => t + (s.outSec - s.inSec), 0));

// Does this trim keep the whole take as one piece (so it needs no cutting)?
export function isWholeTake(spans, dur) {
  return !!spans && spans.length === 1 && spans[0].inSec <= 0.001 && spans[0].outSec >= (Number(dur) || 0) - 0.001;
}

// A moment in the take's own time -> where it falls on the timeline, when the
// kept spans are laid back to back from `startSec`. Before the first span it
// is negative-offset from the start (the caller trims the head); inside a gap
// it snaps to the start of the next kept span; after the last it is the end.
export function takeTimeToTimeline(spans, startSec, t) {
  let pos = startSec;
  for (let k = 0; k < spans.length; k++) {
    const s = spans[k];
    if (t < s.inSec) return k === 0 ? pos - (s.inSec - t) : pos;
    if (t <= s.outSec) return pos + (t - s.inSec);
    pos += s.outSec - s.inSec;
  }
  return pos;
}

// Validate a "mark the usable part" request. `existing` is what is stored now;
// cuts left out of the request are kept, `cuts: []` clears them. Returns what
// to store (null = clear the marks) plus the kept spans. Throws {status:400}.
export function parseTrimRequest(body, dur, existing = null) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const num = (x) => (x === null || x === undefined || x === "" ? null : Number(x));
  const inSec = num(body.inSec), outSec = num(body.outSec);
  if ([inSec, outSec].some((x) => x !== null && !(Number.isFinite(x) && x >= 0))) throw bad("in and out must be seconds, 0 or more");
  if (inSec !== null && inSec >= dur) throw bad(`in (${inSec}s) is past the end of the take (${dur.toFixed(2)}s)`);
  if (inSec !== null && outSec !== null && outSec - inSec < MIN_SPAN) throw bad("out must be after in");
  let cuts = existing && Array.isArray(existing.cuts) ? existing.cuts : [];
  if (Array.isArray(body.cuts)) {
    for (const c of body.cuts) {
      const s = Number(c && c.startSec), e = Number(c && c.endSec);
      if (!(Number.isFinite(s) && Number.isFinite(e) && s >= 0 && e > s)) throw bad("each cut needs a start and a later end, in seconds");
    }
    cuts = body.cuts;
  }
  cuts = normalizeCuts(cuts, dur);
  const stored = { inSec, outSec: outSec === null ? null : Math.min(outSec, dur) };
  const spans = trimSpans({ ...stored, cuts }, dur);
  if (!spans.length) throw bad("those cuts leave no video: nothing of the take would be used");
  if (inSec === null && outSec === null && !cuts.length) return { trim: null, spans };
  return { trim: { ...stored, ...(cuts.length ? { cuts } : {}) }, spans };
}
