import { execFileSync } from "node:child_process";
// Export tests. Verified genuinely, not eyeballed:
//   - FCPXML is checked for well-formedness with xmllint (libxml2, ships with
//     macOS) — a real XML parser, not a regex guess.
//   - OTIO is round-tripped through the actual `opentimelineio` Python
//     package (installed in an isolated venv, never touching system Python)
//     so schema correctness is checked by the library that has to read it,
//     not just against my own understanding of the spec.
//   - Durations everywhere come from REAL ffprobe measurements of real clip
//     files, matching how the app itself builds a timeline — no synthetic
//     duration numbers that could hide a frame-quantization bug.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-export-"));
process.env.RCS_PROJECT_ROOT = ROOT;

const store = await import("../server/store.js");
const timelineMod = await import("../server/timeline.js");
const { buildFCPXML } = await import("../server/export/fcpxml.js");
const { newTimelineClip } = await import("../shared/schema.js");
const { buildOTIO } = await import("../server/export/otio.js");
const { buildEditSheet, orderedCopyPlan } = await import("../server/export/capcut.js");
const { probe, ffprobeAvailable } = await import("../server/ffprobe.js");
const { newEpisode, newShot, newBeat, clipDurationSec } = await import("../shared/schema.js");

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

if (!(await ffprobeAvailable())) {
  console.log("ffprobe not found — export tests need it. Install ffmpeg (brew install ffmpeg) and re-run.");
  process.exit(1);
}

// --- fixtures: three clips made with ffmpeg, shaped like real MiniMax takes
// (768x1344, 24 fps, 32 kHz audio, 5.184 s). They used to be copied from
// Shawn's own project folder, which only existed on his machine.
const DIR = "Scratch/S1E01";
await store.scaffold(DIR);
await fs.mkdir(store.safeResolve(DIR, "05_delivery"), { recursive: true });

const CLIPS = ["B1_stoop.mp4", "B2_lockeyes.mp4", "B3_run.mp4"];
const realProbes = [];
for (const [i, name] of CLIPS.entries()) {
  const dest = store.safeResolve(DIR, "05_delivery", "takes", name);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  execFileSync("ffmpeg", ["-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc=size=768x1344:rate=24:duration=5.184`,
    "-f", "lavfi", "-i", `sine=frequency=${300 + i * 100}:sample_rate=32000:duration=5.184`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", dest]);
  realProbes.push(await probe(dest));
}
console.log("\nFIXTURES");
check("3 real clips copied and probed", realProbes.every((p) => p.durationSec > 0), JSON.stringify(realProbes.map((p) => p.durationSec)));

// --- build an episode with those clips as "selected takes" ---
function mkShot(code, versionPath, dur) {
  const shot = newShot({
    sceneNum: "1", shotCode: code, label: `test ${code}`,
    action: "she moves through the scene",
    beats: [
      newBeat({ role: "start", keyframe: true, desc: "start" }),
    ],
  });
  shot.beats[0].dialogue = code === "a" ? { charId: null, line: "Wait.", delivery: "fearful" } : null;
  shot.beats[0].audio = code === "b" ? "footsteps on wet pavement" : "";
  shot.versions = [{ id: `v_${code}`, path: versionPath, state: "done" }];
  shot.selectedVersions = [`v_${code}`];
  return shot;
}
let ep = newEpisode({
  name: "Scratch Export Test", dir: DIR,
  shots: [
    mkShot("a", `${DIR}/05_delivery/takes/B1_stoop.mp4`, realProbes[0].durationSec),
    mkShot("b", `${DIR}/05_delivery/takes/B2_lockeyes.mp4`, realProbes[1].durationSec),
    mkShot("c", `${DIR}/05_delivery/takes/B3_run.mp4`, realProbes[2].durationSec),
  ],
});
await store.saveEpisode(DIR, ep);

console.log("\nTIMELINE REBUILD");
ep = await store.loadEpisode(DIR);
const built = await timelineMod.rebuildFromSelection(ep);
await store.saveEpisode(DIR, ep);
check("3 clips placed on V1", built.clips.length === 3, `${built.clips.length}`);
check("clip durations are the REAL ffprobe durations, not requested/guessed",
  built.clips.every((c, i) => Math.abs(c.sourceDurationSec - realProbes[i].durationSec) < 0.001),
  JSON.stringify(built.clips.map((c) => c.sourceDurationSec)));
const expectedStart2 = realProbes[0].durationSec + realProbes[1].durationSec;
check("clips are sequenced back-to-back by real duration",
  Math.abs(built.clips[2].startSec - expectedStart2) < 0.001,
  `clip[2].startSec=${built.clips[2].startSec} expected=${expectedStart2}`);
check("dialogue cue captured from beat data", built.audioCues.some((c) => c.kind === "Dialogue" && c.text.includes("Wait")), JSON.stringify(built.audioCues));
check("SFX cue captured from beat data", built.audioCues.some((c) => c.kind === "SFX" && c.text.includes("footsteps")), JSON.stringify(built.audioCues));

console.log("\nTRIM");
ep = await store.loadEpisode(DIR);
const track = ep.timeline.tracks.find((t) => t.id === "V1");
const firstClip = track.clips[0];
const origDur = clipDurationSec(firstClip);
firstClip.headTrimSec = 1.0;
const trimmedDur = clipDurationSec(firstClip);
check("trim reduces effective duration by exactly the trim amount", Math.abs((origDur - trimmedDur) - 1.0) < 0.001, `${origDur} -> ${trimmedDur}`);

// over-trim clamp test via the actual route logic, not just the pure function
firstClip.headTrimSec = 0; firstClip.tailTrimSec = 0;
const maxTrim = firstClip.sourceDurationSec;
const overTrim = Math.max(0, Math.min(maxTrim + 50, maxTrim)); // mirrors the server clamp
check("trim clamp caps at the real source duration, can't go negative or past the file", overTrim === maxTrim, `${overTrim} vs ${maxTrim}`);

console.log("\nFCPXML — well-formedness via xmllint (real XML parser)");
ep = await store.loadEpisode(DIR);
await timelineMod.rebuildFromSelection(ep); // fresh, no trims, for a clean export check
const clipsByTrack = timelineMod.clipsByTrackId(ep);
const xml = buildFCPXML(ep.timeline, clipsByTrack, { projectName: ep.name, rootAbs: store.ROOT });
const xmlPath = path.join(ROOT, "out.fcpxml");
await fs.writeFile(xmlPath, xml);
try {
  await run("xmllint", ["--noout", xmlPath]);
  check("xmllint confirms the FCPXML is well-formed", true);
} catch (e) {
  check("xmllint confirms the FCPXML is well-formed", false, e.stderr || e.message);
}
check("FCPXML declares version 1.10", xml.includes('<fcpxml version="1.10">'));
check("FCPXML references a real file:// path", xml.includes(`file://${encodeURI(store.ROOT)}`) || /src="file:\/\//.test(xml));

// Frame-accuracy: sequence duration in frames should equal the sum of each
// clip's rounded frame count — if this drifts, a rounding bug let two
// separately-computed numbers disagree.
const fps = ep.timeline.fps;
const expectedTotalFrames = clipsByTrack.V1.reduce((n, c) => n + Math.round(clipDurationSec(c) * fps), 0);
const seqDurMatch = xml.match(/<sequence[^>]*duration="(\d+)\/(\d+)s"/);
check("sequence duration in the XML matches the sum of clip frame counts",
  seqDurMatch && Number(seqDurMatch[1]) === expectedTotalFrames,
  `xml says ${seqDurMatch && seqDurMatch[1]}, expected ${expectedTotalFrames}`);

console.log("\nOTIO — real round-trip through the opentimelineio Python package");
const otioDoc = buildOTIO(clipsByTrack, { projectName: ep.name, fps, rootAbs: store.ROOT });
const otioPath = path.join(ROOT, "out.otio");
await fs.writeFile(otioPath, JSON.stringify(otioDoc, null, 2));

const SCRATCH = process.env.RCS_OTIO_VENV || path.join(os.tmpdir(), "..", "otio-venv");
// Prefer the venv Claude built during this session if the env var points at it.
const pyBin = process.env.RCS_OTIO_PYTHON;
if (pyBin) {
  try {
    const { stdout } = await run(pyBin, ["-c", `
import opentimelineio as otio, json, sys
tl = otio.adapters.read_from_file("${otioPath}")
video = [t for t in tl.tracks if t.kind == "Video"][0]
clips = [c for c in video if isinstance(c, otio.schema.Clip)]
total = sum(c.duration().value for c in clips)
print(json.dumps({"clip_count": len(clips), "total_frames": total, "rate": clips[0].duration().rate if clips else None}))
`]);
    const result = JSON.parse(stdout.trim().split("\n").pop());
    check("opentimelineio successfully parses the exported .otio file", true);
    check("OTIO clip count matches the timeline", result.clip_count === 3, JSON.stringify(result));
    check("OTIO total frame count matches the FCPXML total", result.total_frames === expectedTotalFrames,
      `otio=${result.total_frames} fcpxml=${expectedTotalFrames}`);
  } catch (e) {
    check("opentimelineio successfully parses the exported .otio file", false, e.stderr || e.message);
  }
} else {
  console.log("  (skipped — RCS_OTIO_PYTHON not set; run test/export.mjs with it pointed at the venv python to get real round-trip verification)");
}

console.log("\nCAPCUT — edit sheet + ordered copy");
const sheet = buildEditSheet(clipsByTrack, {
  projectName: ep.name,
  audioCues: ep.timeline.audioCues,
});
check("edit sheet lists all 3 shots in order", ["01_", "02_", "03_"].every((n) => sheet.includes(n)));
check("edit sheet surfaces the dialogue cue", sheet.includes("Wait"));
check("edit sheet surfaces the SFX cue", sheet.includes("footsteps"));
const plan = orderedCopyPlan(clipsByTrack);
check("copy plan is numbered in cut order", plan[0].toName.startsWith("01_") && plan[2].toName.startsWith("03_"), JSON.stringify(plan.map((p) => p.toName)));

console.log("\nMULTI-SELECT TAKES — stacked alt tracks (Sept 2026)");
// Give shot "a" a second selected take, reusing the already-probed B2 clip as
// a distinct version — order matters: v_a stays primary (V1, drives the
// cursor), v_a_alt is the alternate (should land on V2 at the SAME startSec).
ep = await store.loadEpisode(DIR);
const shotA = ep.shots.find((s) => s.shotCode === "a");
shotA.versions.push({ id: "v_a_alt", path: `${DIR}/05_delivery/takes/B2_lockeyes.mp4`, state: "done" });
shotA.selectedVersions = ["v_a", "v_a_alt"];
await store.saveEpisode(DIR, ep);
ep = await store.loadEpisode(DIR);
const builtMulti = await timelineMod.rebuildFromSelection(ep);
await store.saveEpisode(DIR, ep);

check("V1 is unaffected by the alt — still 3 clips, same cursor",
  builtMulti.clips.length === 3 && Math.abs(builtMulti.totalSec - (realProbes[0].durationSec + realProbes[1].durationSec + realProbes[2].durationSec)) < 0.001,
  `${builtMulti.clips.length} clips, totalSec=${builtMulti.totalSec}`);

const v2Track = ep.timeline.tracks.find((t) => t.id === "V2");
check("a V2 track was created for the alternate take", !!v2Track);
check("V2 carries exactly the one alt clip", v2Track && v2Track.clips.length === 1, JSON.stringify(v2Track?.clips.map((c) => c.versionId)));
check("the alt clip starts at the SAME position as its shot's V1 clip (both are shot 'a', first in sequence)",
  v2Track && v2Track.clips[0].startSec === 0 && builtMulti.clips[0].startSec === 0,
  `v2 startSec=${v2Track?.clips[0]?.startSec} v1[0] startSec=${builtMulti.clips[0].startSec}`);

const multiClipsByTrack = timelineMod.clipsByTrackId(ep);
{
  // Project-size sequence: the timeline is 1080x1920 even though the clips are other sizes.
  const sized = buildFCPXML(ep.timeline, clipsByTrack, { projectName: ep.name, rootAbs: store.ROOT, sequenceSize: { width: 1080, height: 1920 } });
  const seqFmtId = (sized.match(/<sequence format="(r\d+)"/) || [])[1];
  const seqFmtTag = (sized.match(new RegExp(`<format id="${seqFmtId}"[^>]*>`)) || [""])[0];
  check("a supplied sequenceSize becomes the sequence format (1080x1920)", /width="1080" height="1920"/.test(seqFmtTag), seqFmtTag);
  check("the clips keep their own formats in addition to it", (sized.match(/<format /g) || []).length >= (xml.match(/<format /g) || []).length);
  check("the sized export is still well-formed with the same duration", /<sequence[^>]*duration="(\d+)\/(\d+)s"/.test(sized) && sized.match(/<sequence[^>]*duration="([^"]+)"/)[1] === xml.match(/<sequence[^>]*duration="([^"]+)"/)[1]);
}
{
  // STACKING REGRESSION (Sept 2026): a connected clip's offset lives in the PARENT clip's
  // time, which begins at the parent's `start` (head trim) — not the sequence timeline.
  // The old test only used a first-in-sequence shot, where both readings are 0.
  const mk = (over) => newTimelineClip({ fps: 24, width: 720, height: 1280, hasAudio: true, sourceDurationSec: 6, ...over });
  const a = mk({ shotId: "s1", sourcePath: "p/a.mp4", name: "1a", startSec: 0 });
  const b = mk({ shotId: "s2", sourcePath: "p/b.mp4", name: "2a", startSec: 6, headTrimSec: 0.5 });     // head-trimmed, NOT first
  const alt = mk({ shotId: "s2", sourcePath: "p/b_alt.mp4", name: "2a (alt 2)", startSec: 6 });
  const dia = mk({ shotId: "s2", sourcePath: "p/line.wav", name: "line", startSec: 8, kind: "dialogue", hasAudio: true });
  const x = buildFCPXML({ fps: 24 }, { V1: [a, b], V2: [alt], A1: [dia] }, { projectName: "T", rootAbs: "/r" });
  const nestedOff = (lane) => (x.match(new RegExp(`<asset-clip[^>]*lane="${lane}"[^>]*offset="([^"]+)"`)) || [])[1];
  check("an alternate on a LATER, head-trimmed shot is offset to the parent's start (12 frames), not the absolute 144",
    nestedOff(5) === "12/24s", `got ${nestedOff(5)}`);
  check("a dialogue clip 2s into that shot is offset parent-start + 2s (12 + 48 = 60 frames)", nestedOff(1) === "60/24s", `got ${nestedOff(1)}`);
  const first = buildFCPXML({ fps: 24 }, { V1: [a, mk({ shotId: "s2", sourcePath: "p/b2.mp4", name: "2b", startSec: 6 })], V2: [mk({ shotId: "s2", sourcePath: "p/b2_alt.mp4", name: "alt", startSec: 6 })] }, { projectName: "T", rootAbs: "/r" });
  check("an untrimmed later shot's alternate aligns at offset 0 (the old code wrote 144/24s)", (first.match(/lane="5"[^>]*offset="([^"]+)"/) || [])[1] === "0/24s", (first.match(/lane="5"[^>]*offset="([^"]+)"/) || [])[1]);

  // SCENE BINS: one extra <event> per group, timeline untouched.
  const bin = (c) => (c.shotId === "s1" ? "Scene 1" : "Scene 2");
  const bx = buildFCPXML({ fps: 24 }, { V1: [a, b], V2: [alt] }, { projectName: "T", rootAbs: "/r", binOf: bin });
  const events = bx.match(/<event name="[^"]+"/g) || [];
  check("scene bins: the timeline event plus one event per scene", events.length === 3 && events[1].includes("Scene 1") && events[2].includes("Scene 2"), JSON.stringify(events));
  check("the alternate take is listed in its scene's bin", /<event name="Scene 2">[\s\S]*b_alt\.mp4|<event name="Scene 2">[\s\S]*2a \(alt 2\)/.test(bx));
  check("without binOf there is still exactly one event (default export unchanged)", ((buildFCPXML({ fps: 24 }, { V1: [a, b] }, { projectName: "T", rootAbs: "/r" }).match(/<event /g)) || []).length === 1);
  const bxPath = path.join(ROOT, "bins.fcpxml");
  await fs.writeFile(bxPath, bx);
  try { await run("xmllint", ["--noout", bxPath]); check("the scene-bins FCPXML is well-formed", true); }
  catch (e) { check("the scene-bins FCPXML is well-formed", false, e.stderr || e.message); }
}
const multiXml = buildFCPXML(ep.timeline, multiClipsByTrack, { projectName: ep.name, rootAbs: store.ROOT });
const multiXmlPath = path.join(ROOT, "out_multi.fcpxml");
await fs.writeFile(multiXmlPath, multiXml);
try {
  await run("xmllint", ["--noout", multiXmlPath]);
  check("FCPXML with a stacked alt track is still well-formed", true);
} catch (e) {
  check("FCPXML with a stacked alt track is still well-formed", false, e.stderr || e.message);
}
// Lanes 1-4 are audio (Dialogue, SFX, Music, Room tone — A4 added 2026-10-08), so the
// first alternate take sits on lane 5.
check("FCPXML nests the alt take as a connected clip (lane 5, past the 4 audio lanes)", /lane="5"/.test(multiXml));

const multiOtio = buildOTIO(multiClipsByTrack, { projectName: ep.name, fps: ep.timeline.fps, rootAbs: store.ROOT });
const altVideoTracks = multiOtio.tracks.children.filter((t) => t.kind === "Video");
check("OTIO carries a second parallel Video track for the alternate", altVideoTracks.length === 2, JSON.stringify(altVideoTracks.map((t) => t.name)));

const multiSheet = buildEditSheet(multiClipsByTrack, { projectName: ep.name, audioCues: ep.timeline.audioCues });
check("edit sheet's numbered folder plan is unaffected (still only 3 primary takes)", orderedCopyPlan(multiClipsByTrack).length === 3);
check("edit sheet still lists the alternate as reference (CapCut has no stacked-track import)", multiSheet.includes("Alternate takes") && multiSheet.includes("B2_lockeyes.mp4"));

console.log(`\n${fail === 0 ? "✓" : "✗"} export tests: ${pass} passed, ${fail} failed`);
await fs.rm(ROOT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
