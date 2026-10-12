// "Add sound to my Resolve cut": placement on HIS timeline, text-only edits,
// re-runs that replace instead of doubling.
import { planSound, writeSoundCut, scanSpine } from "../server/soundcut.js";
import { parseCut, analyzeCut } from "../server/cut.js";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const near = (a, b) => Math.abs(a - b) < 0.05;

const ROOT = "/proj", T = "S/E/05_delivery/takes";
const url = (rel) => `file://${encodeURI(`${ROOT}/${rel}`)}`;
const asset = (id, rel) => `<asset id="${id}" name="${rel.split("/").pop()}" start="0s" duration="10s" hasVideo="1" hasAudio="1" format="r1"><media-rep kind="original-media" src="${url(rel)}"/></asset>`;
// Shot A (scene 1): take vA, used from 2 s (head trimmed), 0–3 s on the timeline.
// Shot B (scene 1): a cutaway 3–4 s hosted on a GAP, then A again 4–6 s (same take, continuous).
// Shot C (scene 2): 6–9 s, self-closing clip.
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.10">
 <resources>
  <format id="r1" width="1080" height="1920" frameDuration="1/24s"/>
  ${asset("r2", `${T}/1a_M_vA.mp4`)}
  ${asset("r3", `${T}/1b_M_vB.mp4`)}
  ${asset("r4", `${T}/2a_M_vC.mp4`)}
 </resources>
 <library><event name="E"><project name="P"><sequence format="r1" duration="9s"><spine>
  <asset-clip ref="r2" offset="0s" start="2s" duration="3s" name="A1"/>
  <gap offset="3s" start="3600s" duration="1s" name="Gap">
   <asset-clip ref="r3" lane="1" offset="3600s" start="0s" duration="1s" name="B"/>
  </gap>
  <asset-clip ref="r2" offset="4s" start="6s" duration="2s" name="A2"/>
  <asset-clip ref="r4" offset="6s" start="0s" duration="3s" name="C"/>
 </spine></sequence></project></event></library>
</fcpxml>`;

const ep = {
  scenes: [
    { number: "1", roomTone: { takes: [{ id: "t1", path: "S/E/05_delivery/audio/roomtone/s1.mp3", seconds: 4 }], useId: "t1" } },
    { number: "2", roomTone: { takes: [{ id: "t2", path: "S/E/05_delivery/audio/roomtone/s2.mp3", seconds: 4 }], useId: null } },
  ],
  shots: [
    { id: "A", sceneNum: "1", shotCode: "a", versions: [{ id: "vA", path: `${T}/1a_M_vA.mp4`, state: "done" }], selectedVersions: ["vA"],
      beats: [{ id: "b1", dialogue: { line: "From the take", useClipId: "dA" } }, { id: "b2", dialogue: { line: "Early line", useClipId: "dE" } }],
      audioClips: [
        { id: "dA", path: "S/E/05_delivery/audio/dialogue/voiced/a.mp3", seconds: 2.5, kind: "voiced", origin: "take", sourceVersionId: "vA", offsetSec: 2.5, beatId: "b1" },
        { id: "dE", path: "S/E/05_delivery/audio/dialogue/voiced/e.mp3", seconds: 3, kind: "voiced", origin: "take", sourceVersionId: "vA", offsetSec: 0.5, beatId: "b2" },
      ] },
    { id: "B", sceneNum: "1", shotCode: "b", versions: [{ id: "vB", path: `${T}/1b_M_vB.mp4`, state: "done" }], selectedVersions: ["vB"],
      beats: [{ id: "b3", dialogue: { line: "My own read", useClipId: "dP" } }],
      audioClips: [{ id: "dP", path: "S/E/05_delivery/audio/dialogue/voiced/p.mp3", seconds: 0.8, kind: "voiced", origin: "performance", beatId: "b3" }] },
    { id: "C", sceneNum: "2", shotCode: "a", versions: [{ id: "vC", path: `${T}/2a_M_vC.mp4`, state: "done" }], selectedVersions: ["vC"], beats: [] },
    { id: "D", sceneNum: "2", shotCode: "b", versions: [], selectedVersions: [],
      beats: [{ id: "b4", dialogue: { line: "Not in the cut", useClipId: "dX" } }],
      audioClips: [{ id: "dX", path: "x.mp3", seconds: 1, kind: "voiced", origin: "take" }] },
  ],
};

const analysis = analyzeCut(ep, parseCut(xml), ROOT);
const plan = planSound(ep, analysis);
const line = (t) => plan.dialogue.find((d) => d.line === t);

console.log("plan");
check("a take-voiced line sits where that part of the take plays (2.5 s into vA = 0.5 s on the timeline)", near(line("From the take").at, 0.5), JSON.stringify(line("From the take")));
// "Early line": 0.5 s into vA, but the cut shows vA from 2 s at timeline 0, so
// the line's first 1.5 s fall before the cut starts: trimmed, kept in sync.
check("a line that starts before its picture is head-trimmed to stay in sync, with a note",
  line("Early line") && line("Early line").at === 0 && near(line("Early line").inPoint, 1.5) && near(line("Early line").dur, 1.5) && /before its picture/.test(line("Early line").note),
  JSON.stringify(line("Early line")));
check("a performance recording starts at its shot's first picture and is flagged", near(line("My own read").at, 3) && /by ear/.test(line("My own read").note));
check("a line on a shot that isn't in the cut is skipped with a warning", !line("Not in the cut") && plan.warnings.some((w) => /isn't in this cut/.test(w)));
const r1 = plan.roomtone.find((r) => r.sceneNum === "1");
check("room tone spans the scene in HIS cut (0–6 s), tiled 4 + 2", r1 && near(r1.start, 0) && near(r1.end, 6) && r1.tiles.length === 2 && near(r1.tiles[1].dur, 2));
check("a scene with no loop in the edit gets none", !plan.roomtone.some((r) => r.sceneNum === "2"));

console.log("\nwrite");
const out = writeSoundCut(xml, plan, { root: ROOT, fps: 24 });
const back = parseCut(out.xml);
const added = back.clips.filter((c) => /^RC /.test(c.name || ""));
check("every planned clip is in the file", added.length === plan.dialogue.length + r1.tiles.length, String(added.length));
const at = (prefix) => added.filter((c) => c.name.startsWith(prefix)).map((c) => c.tl).sort((a, b) => a - b);
check("read back, the take-voiced line is at 0.5 s", at("RC Dialogue — 1a From").some((t) => near(t, 0.5)), JSON.stringify(at("RC Dialogue")));
check("read back, room tone loops are at 0 s and 4 s", JSON.stringify(at("RC Room tone").map((t) => Math.round(t))) === "[0,4]", JSON.stringify(at("RC Room tone")));
check("a clip that starts inside the gap is hosted by the gap (offset in gap time)", /<gap[^>]*>[\s\S]*RC Dialogue — 1b/.test(out.xml));
check("a self-closing host is opened to take children", /name="C"[^/]*>|<asset-clip ref="r2" offset="0s" start="2s" duration="3s" name="A1">/.test(out.xml));
check("new lanes sit above the existing ones (lane 1 used → 2 and 3)", out.lanes.dialogue === 2 && out.lanes.roomTone === 3);
check("audio files become audio-only assets", (out.xml.match(/hasVideo="0"/g) || []).length === 4);
const sig = (x) => JSON.stringify(parseCut(x).clips.filter((c) => !/^RC /.test(c.name || "")).map((c) => [c.tl, c.dur, c.srcIn, c.lane]));
check("his own clips are unchanged", sig(out.xml) === sig(xml));
check("the spine still scans cleanly", scanSpine(out.xml).children.length === 4);

console.log("\nre-run");
const again = writeSoundCut(out.xml, plan, { root: ROOT, fps: 24 });
check("old RC clips are removed, the same set added again", again.removed === added.length && again.added === out.added);
check("no duplicate clips after a re-run", parseCut(again.xml).clips.filter((c) => /^RC /.test(c.name || "")).length === added.length);
check("audio assets are reused, not duplicated", (again.xml.match(/hasVideo="0"/g) || []).length === 4);

console.log(`\n${fail === 0 ? "✓" : "✗"} sound on the cut: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
