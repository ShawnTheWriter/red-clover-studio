// OpenTimelineIO exporter — a JSON document conforming to the public OTIO
// schema (Timeline.1 / Stack.1 / Track.1 / Clip.1 / ExternalReference.1 /
// TimeRange.1 / RationalTime.1). Vendor-neutral, and the more mechanically
// checkable of the two exports: it's plain JSON against a documented schema,
// so it can be round-tripped through the real `opentimelineio` Python
// package rather than only eyeballed against the spec — see test/export.mjs.
//
// Same frame-quantization discipline as fcpxml.js: every RationalTime value
// is a whole-frame integer against the sequence's rate, computed once in
// timeutil.js and shared by both exporters so they can never disagree with
// each other about where a cut actually falls.

import path from "node:path";
import { secToFrames } from "./timeutil.js";
import { clipDurationSec } from "../../shared/schema.js";

const rt = (frames, rate) => ({ OTIO_SCHEMA: "RationalTime.1", rate, value: frames });
const range = (startFrames, durFrames, rate) => ({
  OTIO_SCHEMA: "TimeRange.1",
  start_time: rt(startFrames, rate),
  duration: rt(durFrames, rate),
});

// Clip.2's real shape, confirmed against the installed opentimelineio
// library itself (0.18.1) rather than assumed from the spec docs: media goes
// under `media_references` — a DICT of named references — plus a separate
// `active_media_reference_key` naming which one is live. A guessed singular
// `media_reference` field parses as valid JSON but fails the moment OTIO
// actually tries to read it (see test/export.mjs — it did, on the first run).
function otioClip(c, fps, rootAbs) {
  const abs = rootAbs ? path.join(rootAbs, c.sourcePath) : c.sourcePath;
  const headFrames = secToFrames(c.headTrimSec || 0, fps);
  const durFrames = secToFrames(clipDurationSec(c), fps);
  return {
    OTIO_SCHEMA: "Clip.2",
    name: c.name || path.basename(c.sourcePath),
    source_range: range(headFrames, durFrames, fps),
    effects: [],
    markers: [],
    enabled: true,
    color: null,
    media_references: {
      DEFAULT_MEDIA: {
        OTIO_SCHEMA: "ExternalReference.1",
        name: "",
        target_url: `file://${encodeURI(abs)}`,
        available_range: range(0, secToFrames(c.sourceDurationSec || 0, fps), fps),
        available_image_bounds: null,
        metadata: {},
      },
    },
    active_media_reference_key: "DEFAULT_MEDIA",
    metadata: c.shotId ? { red_clover: { shotId: c.shotId, versionId: c.versionId || null } } : {},
  };
}

function otioTrack(name, kind, clips, fps, rootAbs) {
  const children = [];
  let cursor = 0;
  for (const c of clips) {
    const startFrames = secToFrames(c.startSec || 0, fps);
    // A gap fills any space between the running cursor and this clip's
    // recorded timeline position, so tracks with sparse audio (a dialogue
    // line partway through a shot, say) stay time-accurate rather than
    // collapsing everything to be back-to-back.
    if (startFrames > cursor) {
      children.push({ OTIO_SCHEMA: "Gap.1", source_range: range(0, startFrames - cursor, fps) });
    }
    const clip = otioClip(c, fps, rootAbs);
    children.push(clip);
    cursor = startFrames + clip.source_range.duration.value;
  }
  return { OTIO_SCHEMA: "Track.1", name, kind, children };
}

export function buildOTIO(clipsByTrack, opts = {}) {
  const fps = opts.fps || 24;
  const rootAbs = opts.rootAbs;
  const v1 = clipsByTrack.V1 || [];
  if (!v1.length) throw new Error("timeline has no video clips to export");

  const tracks = [otioTrack("Picture", "Video", v1, fps, rootAbs)];
  // Alternate takes (V2, V3...) stack as their own parallel Video tracks in
  // the same Stack — OTIO's model natively supports several overlapping
  // video tracks, so this is just "however many exist," not a special case.
  for (let i = 2; clipsByTrack[`V${i}`]; i++) {
    const clips = clipsByTrack[`V${i}`];
    if (clips.length) tracks.push(otioTrack(`Alt ${i}`, "Video", clips, fps, rootAbs));
  }
  [["A1", "Dialogue"], ["A2", "SFX"], ["A3", "Music"], ["A4", "Room tone"]].forEach(([id, name]) => {
    const clips = clipsByTrack[id] || [];
    if (clips.length) tracks.push(otioTrack(name, "Audio", clips, fps, rootAbs));
  });

  return {
    OTIO_SCHEMA: "Timeline.1",
    name: opts.projectName || "Red Clover Sequence",
    global_start_time: rt(0, fps),
    tracks: { OTIO_SCHEMA: "Stack.1", name: "tracks", children: tracks },
  };
}
