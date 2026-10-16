// Cut-outs inside a take's usable part (Shawn, 2026-10-16): "use the whole take
// except 5.0 to 6.04 s". The kept pieces become several clips from one file on
// the timeline; dialogue voiced from the take and the take's SFX follow them;
// the FCPXML carries each piece.
import { trimSpans, normalizeCuts, spansDuration, takeTimeToTimeline, parseTrimRequest, isWholeTake } from "../shared/trim.js";
import { rebuildFromSelection } from "../server/timeline.js";
import { newEpisode, newShot, newTimeline, clipDurationSec } from "../shared/schema.js";
import { buildFCPXML } from "../server/export/fcpxml.js";
import { orderedCopyPlan, buildEditSheet } from "../server/export/capcut.js";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throwsMsg = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

console.log("\nKEPT SPANS");
check("no marks: the whole take", same(trimSpans({}, 12), [{ inSec: 0, outSec: 12 }]));
check("one cut-out (5.0 to 6.04) splits a 12 s take into two pieces", same(trimSpans({ cuts: [{ startSec: 5, endSec: 6.04 }] }, 12), [{ inSec: 0, outSec: 5 }, { inSec: 6.04, outSec: 12 }]));
check("in/out and a cut work together", same(trimSpans({ inSec: 1, outSec: 11, cuts: [{ startSec: 4, endSec: 5 }] }, 12), [{ inSec: 1, outSec: 4 }, { inSec: 5, outSec: 11 }]));
check("a cut touching the start trims the head", same(trimSpans({ cuts: [{ startSec: 0, endSec: 2 }] }, 12), [{ inSec: 2, outSec: 12 }]));
check("a cut past the end is clamped to the take", same(trimSpans({ cuts: [{ startSec: 10, endSec: 99 }] }, 12), [{ inSec: 0, outSec: 10 }]));
check("overlapping cuts merge; unsorted cuts are sorted", same(normalizeCuts([{ startSec: 6, endSec: 8 }, { startSec: 4, endSec: 7 }], 12), [{ startSec: 4, endSec: 8 }]));
check("two separate cuts make three pieces", trimSpans({ cuts: [{ startSec: 2, endSec: 3 }, { startSec: 6, endSec: 7 }] }, 12).length === 3);
check("a piece shorter than 0.1 s is dropped", same(trimSpans({ cuts: [{ startSec: 0.05, endSec: 12 }] }, 12), []));
check("kept length adds up (12 − 1.04 = 10.96)", spansDuration(trimSpans({ cuts: [{ startSec: 5, endSec: 6.04 }] }, 12)) === 10.96);
check("the whole take is recognised as needing no cutting", isWholeTake(trimSpans({}, 12), 12) && !isWholeTake(trimSpans({ inSec: 1 }, 12), 12));

console.log("\nTAKE TIME → TIMELINE");
{
  const sp = trimSpans({ cuts: [{ startSec: 5, endSec: 6.04 }] }, 12);
  check("before the cut: straight offset from the shot's start", takeTimeToTimeline(sp, 100, 3) === 103);
  check("after the cut: the cut-out length is taken out (8 s of take = 6.96 s in)", Math.abs(takeTimeToTimeline(sp, 100, 8) - 106.96) < 1e-9);
  check("inside the cut-out: snaps to where the next piece starts", takeTimeToTimeline(sp, 100, 5.5) === 105);
  check("before the first piece: negative offset (the caller trims the head)", takeTimeToTimeline(trimSpans({ inSec: 2 }, 12), 100, 1) === 99);
}

console.log("\nREQUEST VALIDATION");
{
  const r = parseTrimRequest({ cuts: [{ startSec: 5, endSec: 6.04 }] }, 12, null);
  check("cuts alone are a valid mark and are stored with null in/out", r.trim && r.trim.inSec === null && r.trim.cuts.length === 1 && r.spans.length === 2);
  check("existing cuts are kept when the request does not mention them", parseTrimRequest({ inSec: 1, outSec: null }, 12, r.trim).trim.cuts.length === 1);
  check("cuts: [] clears them; nothing left means clear the marks", parseTrimRequest({ inSec: null, outSec: null, cuts: [] }, 12, r.trim).trim === null);
  check("a cut that removes everything is refused", /leave no video/.test(throwsMsg(() => parseTrimRequest({ cuts: [{ startSec: 0, endSec: 12 }] }, 12, null)) || ""));
  check("a cut with no end is refused", /cut needs a start/.test(throwsMsg(() => parseTrimRequest({ cuts: [{ startSec: 2 }] }, 12, null)) || ""));
  check("an in past the end is still refused", /past the end/.test(throwsMsg(() => parseTrimRequest({ inSec: 20 }, 12, null)) || ""));
  check("a stored trim without cuts keeps the old shape", same(parseTrimRequest({ inSec: 3, outSec: 7 }, 12, null).trim, { inSec: 3, outSec: 7 }));
}

console.log("\nTIMELINE — one clip per kept piece");
const rec = { id: "R1", path: "ep/audio/line.wav", seconds: 2, origin: "take", offsetSec: 8, sourceVersionId: "va" };
const sfxTake = { id: "S1", path: "ep/sfx/s.wav", seconds: 12, label: "rain", prompt: "rain" };
const shotA = newShot({
  id: "a", sceneNum: "1", shotCode: "a",
  versions: [{ id: "va", state: "done", path: "ep/takes/a.mp4", seconds: 12 }], selectedVersions: ["va"],
  takeTrims: { va: { inSec: null, outSec: null, cuts: [{ startSec: 5, endSec: 6.04 }] } },
  audioClips: [rec], beats: [{ id: "b1", dialogue: { useClipId: "R1", line: "Ready, lads?" } }],
});
shotA.sfx = { prompt: "", useId: "S1", takes: [sfxTake] }; // newShot() does not carry sfx through
const shotB = newShot({ id: "b", sceneNum: "1", shotCode: "b", versions: [{ id: "vb", state: "done", path: "ep/takes/b.mp4", seconds: 5 }], selectedVersions: ["vb"], takeTrims: {} });
const ep = newEpisode({ dir: "ep", shots: [shotA, shotB], timeline: newTimeline() });
const v1 = ep.timeline.tracks.find((x) => x.id === "V1");
// Probed durations ride on existing clips so nothing touches the disk.
v1.clips = [
  { id: "ca", shotId: "a", versionId: "va", sourcePath: "ep/takes/a.mp4", kind: "video", sourceDurationSec: 12, fps: 24, width: 480, height: 854, hasAudio: true, headTrimSec: 0, tailTrimSec: 0, startSec: 0 },
  { id: "cb", shotId: "b", versionId: "vb", sourcePath: "ep/takes/b.mp4", kind: "video", sourceDurationSec: 5, fps: 24, width: 480, height: 854, hasAudio: true, headTrimSec: 0, tailTrimSec: 0, startSec: 0 },
];
const out = await rebuildFromSelection(ep);
const clips = ep.timeline.tracks.find((x) => x.id === "V1").clips;
const [c0, c1, cb] = clips;
check("shot a becomes two clips from one file, shot b a third", clips.length === 3 && c0.versionId === "va" && c1.versionId === "va" && cb.versionId === "vb", clips.map((c) => c.name).join(" | "));
check("piece 1: 0 to 5 s of the file at timeline 0", c0.headTrimSec === 0 && c0.tailTrimSec === 7 && c0.startSec === 0 && clipDurationSec(c0) === 5);
check("piece 2: 6.04 to 12 s of the file, butted up to piece 1 at 5 s", c1.headTrimSec === 6.04 && c1.tailTrimSec === 0 && c1.startSec === 5 && Math.abs(clipDurationSec(c1) - 5.96) < 1e-9, JSON.stringify(c1));
check("the pieces know which they are", c0.spanIndex === 0 && c0.spanCount === 2 && c1.spanIndex === 1 && c1.spanCount === 2);
check("names say [1/2] and [2/2]", /\[1\/2\]$/.test(c0.name) && /\[2\/2\]$/.test(c1.name));
check("the next shot starts after BOTH pieces (10.96 s)", Math.abs(cb.startSec - 10.96) < 1e-9 && Math.abs(out.totalSec - 15.96) < 1e-9, `${cb.startSec} / ${out.totalSec}`);

const a1 = ep.timeline.tracks.find((x) => x.id === "A1").clips;
check("a line voiced from the take at 8 s lands 1.04 s earlier on the timeline (6.96)", a1.length === 1 && Math.abs(a1[0].startSec - 6.96) < 0.002, JSON.stringify(a1.map((c) => c.startSec)));
const a2 = ep.timeline.tracks.find((x) => x.id === "A2").clips;
check("the SFX is cut the same way: one piece per picture piece", a2.length === 2, String(a2.length));
check("SFX piece 1 runs from the take's 0 s for 5 s; piece 2 from 6.04 s for 5.96 s", a2[0].headTrimSec === 0 && Math.abs(clipDurationSec(a2[0]) - 5) < 0.002 && a2[1].headTrimSec === 6.04 && Math.abs(clipDurationSec(a2[1]) - 5.96) < 0.002 && a2[1].startSec === 5, JSON.stringify(a2.map((c) => [c.headTrimSec, c.tailTrimSec, c.startSec])));

console.log("\nREBUILD KEEPS IDENTITY, AND UNDOES CLEANLY");
{
  const ids = clips.map((c) => c.id);
  await rebuildFromSelection(ep);
  const again = ep.timeline.tracks.find((x) => x.id === "V1").clips;
  check("a second rebuild keeps each piece's id", again.length === 3 && same(again.map((c) => c.id), ids));
  delete shotA.takeTrims.va;
  await rebuildFromSelection(ep);
  const back = ep.timeline.tracks.find((x) => x.id === "V1").clips;
  check("clearing the marks goes back to ONE whole clip with no leftover trims", back.length === 2 && back[0].versionId === "va" && back[0].headTrimSec === 0 && back[0].tailTrimSec === 0 && back[0].spanCount === undefined, JSON.stringify(back[0]));
  check("and the SFX goes back to one piece", ep.timeline.tracks.find((x) => x.id === "A2").clips.length === 1);
  shotA.takeTrims.va = { inSec: null, outSec: null, cuts: [{ startSec: 5, endSec: 6.04 }] };
  await rebuildFromSelection(ep);
}

console.log("\nFCPXML — each piece is its own clip on one asset");
{
  const clips2 = ep.timeline.tracks.find((x) => x.id === "V1").clips;
  const xml = buildFCPXML(ep.timeline, { V1: clips2 }, { projectName: "t", rootAbs: "/r", sequenceSize: { width: 1080, height: 1920 } });
  const lines = xml.split("\n").filter((l) => l.includes("<asset-clip") && l.includes("1a"));
  check("two asset-clips for shot a", lines.length === 2, String(lines.length));
  check("piece 1 offset 0, start 0, runs 5 s", /offset="(0s|0\/24s)"/.test(lines[0]) && /start="(0s|0\/24s)"/.test(lines[0]) && /duration="120\/24s"|duration="5s"/.test(lines[0]), lines[0]);
  check("piece 2 offset 5 s, start 6.04 s (145/24 rounded), runs about 5.96 s", /offset="120\/24s"|offset="5s"/.test(lines[1]) && /start="145\/24s"/.test(lines[1]), lines[1]);
  const assets = xml.split("\n").filter((l) => l.includes("<asset ") && l.includes("a.mp4"));
  check("the file is listed as ONE asset, not two", assets.length === 1, String(assets.length));
}

console.log("\nCAPCUT — one copy per file");
{
  const clips3 = ep.timeline.tracks.find((x) => x.id === "V1").clips;
  const plan = orderedCopyPlan({ V1: clips3 });
  check("a take cut in two is copied once, the next shot keeps its own number (01 and 03)", plan.length === 2 && plan[0].toName.startsWith("01_") && plan[1].toName.startsWith("03_"), JSON.stringify(plan));
}

console.log(`\n${fail ? "✗" : "✓"} trim cut-outs: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
