// FCPXML 1.10 exporter, targeting DaVinci Resolve.
//
// SCOPE, STATED HONESTLY: the real pipeline (Phase 3) produces one video file
// per take with audio already baked in by the generation model — MiniMax H3
// and Kling both generate synchronized audio, so there is no separate
// dialogue/SFX/music FILE to place on its own track yet. This exporter's
// primary, exercised path is therefore a single V1 spine of picture clips,
// each carrying its own embedded audio.
//
// A1/A2/A3 (dialogue/SFX/music) support is implemented to spec below —
// connected clips nested under the V1 clip whose time range contains them,
// using `lane` for vertical stacking — for the day separate audio elements
// exist. It has NOT been exercised against a real import, because there is
// nothing in the current data to test it with. Say so in the UI rather than
// implying it's been proven the way the V1-only path has.
//
// Alternate takes (a shot with more than one selected take, Sept 2026) reuse
// this exact same connected-clip/lane mechanism, one lane per alt track past
// the audio lanes — see nestTrackIds below. This path IS exercised (real
// clips, real xmllint check) in test/export.mjs, unlike the A-track path.
//
// Every duration and offset is frame-quantized via timeutil.js before being
// written, so the numbers in the file are exactly the numbers Resolve will
// use — not a fraction Resolve has to round on its own.

import path from "node:path";
import { secToFrames, frameFraction } from "./timeutil.js";
import { clipDurationSec } from "../../shared/schema.js";

function xmlEscape(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  }[c]));
}

// Group by (fps, width, height) so each distinct clip shape gets its own
// <format> resource — most productions will have exactly one, but nothing
// here assumes it.
function formatKey(c) { return `${c.fps}x${c.width}x${c.height}`; }

export function buildFCPXML(timeline, clipsByTrack, opts = {}) {
  const projectName = opts.projectName || "Red Clover Sequence";
  const eventName = opts.eventName || projectName;
  const rootAbs = opts.rootAbs; // absolute filesystem root to resolve sourcePath against
  const binOf = typeof opts.binOf === "function" ? opts.binOf : null; // clip -> bin (event) name, or null for none
  const sequenceSize = opts.sequenceSize || null; // { width, height } of the program/timeline; default = first clip's

  const v1 = clipsByTrack.V1 || [];
  if (!v1.length) throw new Error("timeline has no video clips to export");

  // Alternate takes (V2, V3...) — same idea as A1-3 below: nested as
  // connected (lane) clips under the V1 clip they align with, since FCPXML's
  // spine only ever carries one primary storyline. They always start at the
  // exact same position as their shot's V1 clip (server/timeline.js), so the
  // existing "falls inside this clip's span" containment check finds them
  // without any special-casing. Video lanes start past the audio lanes
  // (1-3) so they never collide.
  const altTrackIds = [];
  for (let i = 2; clipsByTrack[`V${i}`]; i++) altTrackIds.push(`V${i}`);

  // --- resources: formats + assets, deduplicated ---
  const formats = new Map(); // key -> { id, fps, width, height }
  const assets = new Map();  // sourcePath -> { id, ...clip probe data }
  let fmtSeq = 1, assetSeq = 1;

  const allClips = [
    ...v1,
    ...altTrackIds.flatMap((id) => clipsByTrack[id] || []),
    ...(clipsByTrack.A1 || []), ...(clipsByTrack.A2 || []), ...(clipsByTrack.A3 || []), ...(clipsByTrack.A4 || []),
  ];
  for (const c of allClips) {
    const fps = c.fps || 24;
    const w = c.width || 0, h = c.height || 0;
    // An audio-only clip (a dialogue recording) has no picture, so no video
    // format: writing one made a 0x0 "video" format and a hasVideo asset.
    const audioOnly = c.hasVideo === false;
    const fk = audioOnly ? null : formatKey({ fps, width: w, height: h });
    if (fk && !formats.has(fk)) formats.set(fk, { id: `r${fmtSeq++}`, fps, width: w, height: h });

    if (!assets.has(c.sourcePath)) {
      const durFrames = secToFrames(c.sourceDurationSec || 0, fps);
      assets.set(c.sourcePath, {
        id: `r${fmtSeq + assetSeq}`, // offset past format ids, reassigned below for clarity
        sourcePath: c.sourcePath,
        fps, width: w, height: h,
        durationFrames: durFrames,
        hasAudio: c.hasAudio !== false,
        audioOnly,
        formatKey: fk,
      });
      assetSeq++;
    }
  }
  // The sequence (= the Resolve timeline) gets the PROJECT's size when the
  // caller supplies one, not the first clip's. Clips here arrive in mixed sizes
  // (a 496x864 carryover, 1456x2544 and 720x1280 generations), and inheriting
  // the first clip's made the timeline 496x864. Clips keep their own formats.
  const seqFps = v1[0].fps || 24;
  const seqKey = sequenceSize
    ? formatKey({ fps: seqFps, width: sequenceSize.width, height: sequenceSize.height })
    : formatKey({ fps: seqFps, width: v1[0].width || 0, height: v1[0].height || 0 });
  if (!formats.has(seqKey)) {
    formats.set(seqKey, { id: `r${fmtSeq++}`, fps: seqFps, width: sequenceSize.width, height: sequenceSize.height });
  }
  // Reassign clean sequential ids now that both maps are populated.
  let idc = 1;
  for (const f of formats.values()) f.id = `r${idc++}`;
  for (const a of assets.values()) a.id = `r${idc++}`;

  const seqFmt = formats.get(seqKey);

  const resourcesXML = [
    ...[...formats.values()].map((f) =>
      `    <format id="${f.id}" name="FFVideoFormat${f.width}x${f.height}p${f.fps}" frameDuration="${frameFraction(1, f.fps)}" width="${f.width}" height="${f.height}"/>`),
    ...[...assets.values()].map((a) => {
      const abs = rootAbs ? path.join(rootAbs, a.sourcePath) : a.sourcePath;
      if (a.audioOnly) {
        return `    <asset id="${a.id}" name="${xmlEscape(path.basename(a.sourcePath))}" src="file://${encodeURI(abs)}" start="0s" duration="${frameFraction(a.durationFrames, a.fps)}" hasVideo="0" hasAudio="1" audioSources="1" audioChannels="2"/>`;
      }
      const fmt = formats.get(a.formatKey);
      return `    <asset id="${a.id}" name="${xmlEscape(path.basename(a.sourcePath))}" src="file://${encodeURI(abs)}" start="0s" duration="${frameFraction(a.durationFrames, a.fps)}" hasVideo="1" hasAudio="${a.hasAudio ? 1 : 0}" audioSources="${a.hasAudio ? 1 : 0}" audioChannels="${a.hasAudio ? 2 : 0}" format="${fmt.id}"/>`;
    }),
  ].join("\n");

  // --- spine: V1 clips in order, with A-track and alt-take clips nested
  // where they overlap ---
  const fps = seqFmt.fps;
  let cursorFrames = 0;
  const spineEls = [];
  // Audio gets lanes 1-3; alt-take video tracks get the lanes above that,
  // in track order, so neither range can ever collide.
  // A4 = Room tone (one loop per scene, tiled).
  const nestTrackIds = ["A1", "A2", "A3", "A4", ...altTrackIds];

  for (const c of v1) {
    const asset = assets.get(c.sourcePath);
    const durSec = clipDurationSec(c);
    const durFrames = secToFrames(durSec, fps);
    const startFrames = secToFrames(c.headTrimSec || 0, fps);
    const offsetFrames = cursorFrames;
    const clipStartFrames = secToFrames(c.startSec || 0, fps);
    const clipEndFrames = clipStartFrames + durFrames;

    // Any dialogue/SFX/music clip, or alternate take, whose timeline
    // position falls inside this video clip's span nests under it as a
    // connected (lane) clip — an alt take always starts exactly at its
    // shot's V1 startSec, so it always falls inside its own shot's span.
    const nested = [];
    nestTrackIds.forEach((trackId, laneIdx) => {
      for (const ac of clipsByTrack[trackId] || []) {
        const acStart = secToFrames(ac.startSec || 0, fps);
        if (acStart >= clipStartFrames && acStart < clipEndFrames) {
          const acAsset = assets.get(ac.sourcePath);
          const acDur = secToFrames(clipDurationSec(ac), fps);
          // A connected clip's offset is in the PARENT clip's own time, which
          // begins at the parent's `start` (its head trim) — NOT the sequence
          // timeline. Writing the absolute timeline position put every
          // alternate take in the wrong place unless its shot was the very
          // first one (Shawn saw them "on the right track but offset").
          const acOffset = startFrames + (acStart - clipStartFrames);
          nested.push(
            `      <asset-clip ref="${acAsset.id}" lane="${laneIdx + 1}" offset="${frameFraction(acOffset, fps)}" name="${xmlEscape(ac.name || path.basename(ac.sourcePath))}" duration="${frameFraction(acDur, fps)}" start="${frameFraction(secToFrames(ac.headTrimSec || 0, fps), fps)}"/>`,
          );
        }
      }
    });

    const name = xmlEscape(c.name || path.basename(c.sourcePath));
    if (nested.length) {
      spineEls.push(
        `    <asset-clip ref="${asset.id}" offset="${frameFraction(offsetFrames, fps)}" name="${name}" duration="${frameFraction(durFrames, fps)}" start="${frameFraction(startFrames, fps)}" format="${seqFmt.id}">\n${nested.join("\n")}\n    </asset-clip>`,
      );
    } else {
      spineEls.push(
        `    <asset-clip ref="${asset.id}" offset="${frameFraction(offsetFrames, fps)}" name="${name}" duration="${frameFraction(durFrames, fps)}" start="${frameFraction(startFrames, fps)}" format="${seqFmt.id}"/>`,
      );
    }
    cursorFrames += durFrames;
  }

  const totalFrames = cursorFrames;

  // Scene bins. Resolve turns each <event> in an FCPXML into a bin in the Media
  // Pool, so when the caller says how to group clips, every group becomes an
  // extra event listing its clips (full source, untrimmed, like a bin would).
  // The timeline stays in the first event. Groups keep timeline order.
  let binEventsXML = "";
  if (binOf) {
    const groups = new Map();
    for (const c of [...v1, ...altTrackIds.flatMap((id) => clipsByTrack[id] || [])]) {
      const name = binOf(c);
      if (!name) continue;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(c);
    }
    binEventsXML = [...groups].map(([name, clips]) => {
      const seen = new Set();
      const els = [];
      for (const c of clips) {
        if (seen.has(c.sourcePath)) continue;
        seen.add(c.sourcePath);
        const a = assets.get(c.sourcePath);
        els.push(`      <asset-clip ref="${a.id}" name="${xmlEscape(c.name || path.basename(c.sourcePath))}" start="0s" duration="${frameFraction(a.durationFrames, a.fps)}" format="${formats.get(a.formatKey).id}"/>`);
      }
      return `    <event name="${xmlEscape(name)}">\n${els.join("\n")}\n    </event>`;
    }).join("\n");
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
${resourcesXML}
  </resources>
  <library>
    <event name="${xmlEscape(eventName)}">
      <project name="${xmlEscape(projectName)}">
        <sequence format="${seqFmt.id}" duration="${frameFraction(totalFrames, fps)}" tcStart="0s" tcFormat="NDF">
          <spine>
${spineEls.join("\n")}
          </spine>
        </sequence>
      </project>
    </event>${binEventsXML ? `\n${binEventsXML}` : ""}
  </library>
</fcpxml>
`;
}
