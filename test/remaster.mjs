// "Create Remaster project from XML", end to end on temp files: preview,
// create, the source left untouched, add back, and generation by target
// length. No project data, no spend.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-remaster-"));
process.env.RCS_PROJECT_ROOT = ROOT;
process.env.RCS_RESOLVE_SCRIPTS_DIR = path.join(ROOT, "_resolve-scripts"); // never the real Resolve menu
const store = await import("../server/store.js");
const rem = await import("../server/remaster.js");
const jobs = await import("../server/jobs.js");

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const near = (a, b) => Math.abs(a - b) < 0.01;
const write = async (rel, body = rel) => { await fs.mkdir(path.dirname(path.join(ROOT, rel)), { recursive: true }); await fs.writeFile(path.join(ROOT, rel), body); };
const exists = (rel) => fs.access(path.join(ROOT, rel)).then(() => true, () => false);
const hash = async (rel) => crypto.createHash("sha256").update(await fs.readFile(path.join(ROOT, rel))).digest("hex");

const EP = "Show/S1E1";
const T = `${EP}/05_delivery/takes`, SB = `${EP}/03_storyboard`;
await store.scaffold(EP);
const f = {
  t1a: `${T}/1a_M_v1a.mp4`, t1b: `${T}/1b_M_v1b.mp4`, t1c1: `${T}/1c_M_v1c1.mp4`, t1c2: `${T}/1c_M_v1c2.mp4`,
  t2a: `${T}/2a_M_v2a.mp4`, t2b: `${T}/2b_M_v2b.mp4`, tX: `${T}/X_M_vX.mp4`,
  s1a: `${SB}/01a_a.png`, s1b: `${SB}/01b_b.png`, s2a: `${SB}/02a_a.png`,
};
for (const p of Object.values(f)) await write(p);

const beat = (p) => ({ id: `b${Math.random().toString(36).slice(2, 7)}`, keyframe: true, role: "start", frame: { path: p, approved: true } });
const shot = (id, sceneNum, shotCode, vers, beats = []) => ({ id, sceneNum, shotCode, label: `label ${id}`, move: "push", action: `action ${id}`, versions: vers.map(([vid, p]) => ({ id: vid, path: p, state: "done", driver: "fal" })), selectedVersions: [vers[0]?.[0]].filter(Boolean), beats });
await store.saveEpisode(EP, {
  name: "S1E1", dir: EP, scenes: [{ number: "1", heading: "INT. ONE" }, { number: "2", heading: "EXT. TWO" }],
  shots: [
    shot("A", "1", "a", [["v1a", f.t1a]], [beat(f.s1a)]),
    shot("B", "1", "b", [["v1b", f.t1b]], [beat(f.s1b)]),        // left out of the cut
    shot("C", "1", "c", [["v1c1", f.t1c1], ["v1c2", f.t1c2]], [beat(f.s1a)]), // two takes back to back; shares A's storyboard
    shot("D", "2", "a", [["v2a", f.t2a]], [beat(f.s2a)]),        // its sound also used later, away from its picture
    shot("E", "2", "b", [["v2b", f.t2b]]),                       // audio-only
    shot("F", "X", "a", [["vX", f.tX]]),                         // in the Cut from edit bin
  ],
  ledger: { budgetCapUSD: 50, confirmAboveUSD: 40, spentUSD: 53.84, entries: [{ kind: "adjustment", chargedUSD: 53.84 }] },
});

const url = (rel) => `file://${encodeURI(path.join(ROOT, rel))}`;
const asset = (id, rel) => `<asset id="${id}" name="${path.basename(rel)}" start="0s" duration="10s" hasVideo="1" hasAudio="1" format="r1"><media-rep kind="original-media" src="${url(rel)}"/></asset>`;
const xml = `<?xml version="1.0"?><fcpxml version="1.10"><resources><format id="r1" width="1080" height="1920" frameDuration="1/24s"/>
${asset("a", f.t1a)}${asset("c1", f.t1c1)}${asset("c2", f.t1c2)}${asset("d", f.t2a)}${asset("e", f.t2b)}</resources>
<library><event name="E"><project name="P"><sequence format="r1" duration="12s"><spine>
<asset-clip ref="a" offset="0s" start="1s" duration="3s"/>
<asset-clip ref="c1" offset="3s" start="0s" duration="2s"/>
<asset-clip ref="c2" offset="5s" start="1s" duration="1s"/>
<asset-clip ref="d" offset="6s" start="2s" duration="4s">
  <clip lane="-1" offset="2s" start="0s" duration="1s"><audio ref="e" offset="0s" start="0s" duration="10s"/></clip>
</asset-clip>
<gap offset="10s" start="3600s" duration="2s">
  <clip lane="-1" offset="3600s" start="0s" duration="2s"><audio ref="d" offset="0s" start="0s" duration="10s"/></clip>
</gap>
</spine></sequence></project></event></library></fcpxml>`;
const XML = `${EP}/05_delivery/cut.fcpxml`;
await write(XML, xml);
const srcBefore = await hash(`${EP}/studio.json`);

console.log("preview");
const pv = await rem.previewRemaster(EP, XML);
const ps = (id) => pv.shots.find((s) => s.shotId === id);
check("only shots with picture in the cut come over", pv.shots.map((s) => s.shotId).join("") === "ACD", pv.shots.map((s) => s.shotId).join(""));
check("target = span used + 0.5 s handle each end", near(ps("A").targetSeconds, 4) && near(ps("D").targetSeconds, 5));
check("two takes back to back add up (2 s + 1 s + handles)", near(ps("C").targetSeconds, 4) && ps("C").parts.length === 2);
check("left out lists the dropped, audio-only and binned shots", pv.leftOut.map((l) => l.shotId).sort().join("") === "BEF");
const need = (id) => pv.audioNeeds.find((n) => n.shotId === id);
check("an audio-only shot is an audio need", need("E")?.kind === "audio-only");
check("a take's sound used away from its picture is an audio need (room tone)", need("D")?.kind === "sound-elsewhere" && near(need("D").seconds, 2));
check("the folder sits beside the source", pv.folder === `${EP} - Remaster`);
check("preview wrote nothing", !(await exists(`${EP} - Remaster`)));

console.log("\ncreate");
const res = await rem.createRemaster(EP, XML);
const R = res.folder;
const ep = await store.loadEpisode(R);
const s = (id) => ep.shots.find((x) => x.id === id);
check("a new episode exists", ep.name === "S1E1 — Remaster" && ep.shots.length === 3);
check("no takes, nothing selected", ep.shots.every((x) => !x.versions.length && !x.selectedVersions.length));
check("prompts, camera and labels carry over", s("A").action === "action A" && s("A").move === "push" && s("A").label === "label A");
check("letters close the gap the left-out shot leaves (C becomes 1b)", `${s("C").sceneNum}${s("C").shotCode}` === "1b" && s("C").remaster.sourceCode === "1c");
check("storyboards are copied into the new folder, shared ones once", s("A").beats[0].frame.path === `${R}/03_storyboard/01a_a.png` && s("C").beats[0].frame.path === `${R}/03_storyboard/01a_a.png` && await exists(`${R}/03_storyboard/01a_a.png`) && res.storyboardsCopied === 2);
check("approval carries over, so generation isn't blocked", s("A").beats[0].frame.approved === true);
check("a fresh ledger, nothing spent", ep.ledger.spentUSD === 0 && ep.ledger.entries.length === 0);
check("the remaster starts every shot on H3 Max (Shawn's hybrid base), no per-shot picks carried over", ep.defaultVideoModelId === "minimax/h3-max/image-to-video" && ep.shots.every((x) => x.videoModelId === ""));
check("the episode records where it came from", ep.remaster.sourceDir === EP && ep.remaster.leftOut.length === 3 && ep.remaster.audioNeeds.length === 2);
check("its bins script is written (to the test folder, not Resolve's menu)", await exists("_resolve-scripts/Red Clover - Scene bins (S1E1 - Remaster).lua"));
check("the source episode is untouched", (await hash(`${EP}/studio.json`)) === srcBefore);
check("a second remaster gets its own folder", (await rem.previewRemaster(EP, XML)).folder === `${EP} - Remaster 2`);
let threw = null;
try { await rem.createRemaster(R, XML); } catch (e) { threw = e; }
check("a remaster can't be made from a remaster", threw && threw.status === 400);

console.log("\ngenerate by target length");
const q = jobs.quote(ep, { shotIds: ["A", "D"], modelIds: ["minimax/h3/image-to-video"], seconds: "target" });
check("target 4 s snaps up to MiniMax's shortest take (5 s)", q.lines[0].seconds === 5, JSON.stringify(q.lines.map((l) => l.seconds)));
check("each shot is priced at its own length", q.lines.length === 2 && q.lines.every((l) => l.seconds === 5));
const longEp = JSON.parse(JSON.stringify(ep)); longEp.shots[0].remaster.targetSeconds = 10.58;
check("10.58 s goes to the nearest length, 11 s", jobs.quote(longEp, { shotIds: ["A"], modelIds: ["minimax/h3/image-to-video"], seconds: "target" }).lines[0].seconds === 11);
longEp.shots[0].remaster.targetSeconds = 6.17;
check("6.17 s goes to 6 s on H3 Max, not up to 7 (Shawn, 5b paced too slow at 7)", jobs.quote(longEp, { shotIds: ["A"], modelIds: ["minimax/h3-max/image-to-video"], seconds: "target" }).lines[0].seconds === 6);
longEp.shots[0].remaster.targetSeconds = 4.5;
check("a tie (4.5 s) goes to the longer length", jobs.quote(longEp, { shotIds: ["A"], modelIds: ["minimax/h3-max/image-to-video"], seconds: "target" }).lines[0].seconds === 5);

console.log("\ncut-timed trims");
{
  const { execFileSync } = await import("node:child_process");
  const timeline = await import("../server/timeline.js");
  // A new 5 s take for shot A (span 3 s, handles 0.5 s): head 0.5, tail 1.5.
  const newTake = `${R}/05_delivery/takes/1a_M_new.mp4`;
  await fs.mkdir(path.dirname(path.join(ROOT, newTake)), { recursive: true });
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x568:rate=24:duration=5", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(ROOT, newTake)]);
  await store.withEpisode(R, (e) => { const a = e.shots.find((x) => x.id === "A"); a.versions = [{ id: "nA", state: "done", path: newTake }]; a.selectedVersions = ["nA"]; });
  const re = await store.loadEpisode(R);
  await timeline.rebuildFromSelection(re);
  const c = re.timeline.tracks.find((t) => t.id === "V1").clips.find((x) => x.shotId === "A");
  check("a new remaster take is trimmed to the cut: head = handle, tail = the rest", near(c.headTrimSec, 0.5) && near(c.tailTrimSec, 1.5), JSON.stringify({ h: c.headTrimSec, t: c.tailTrimSec }));
  c.headTrimSec = 0.2;
  await timeline.rebuildFromSelection(re);
  check("a trim set by hand survives the next rebuild", near(re.timeline.tracks.find((t) => t.id === "V1").clips.find((x) => x.shotId === "A").headTrimSec, 0.2));
}

console.log("\nproof-of-concept take as a reference clip");
{
  const { execFileSync } = await import("node:child_process");
  const { probe } = await import("../server/ffprobe.js");
  // Make A's source take a real 10 s video (the cut uses 1–4 s of it).
  const srcBeforeRef = await hash(`${EP}/studio.json`);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x568:rate=24:duration=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mp4", path.join(ROOT, f.t1a)]);
  const takeBefore = await hash(f.t1a);
  const cp = await rem.cutParts(R, "A");
  check("the shot lists its part of the old take, off by default", cp.remaster && cp.parts.length === 1 && near(cp.parts[0].srcIn, 1) && near(cp.parts[0].srcOut, 4) && cp.parts[0].onDisk && !cp.parts[0].use && !cp.parts[0].refVideoId, JSON.stringify(cp));
  check("a shot cut from two takes lists both parts", (await rem.cutParts(R, "C")).parts.length === 2);
  check("nothing is trimmed until it's switched on", !(await exists(`${R}/02_assets/reference_video`)) || !(await fs.readdir(path.join(ROOT, R, "02_assets/reference_video"))).length);
  const on = await rem.useCutPart(R, "A", 0, true, { probe });
  const e1 = await store.loadEpisode(R);
  const rv = e1.shots.find((x) => x.id === "A").refVideos;
  check("switching on trims the part into the remaster's reference_video folder", on.made && on.path.startsWith(`${R}/02_assets/reference_video/poc_1a_`) && await exists(on.path));
  check("the clip is the cut's 3 s, measured", rv.length === 1 && Math.abs(rv[0].seconds - 3) < 0.15 && rv[0].width === 320, JSON.stringify(rv[0]));
  check("it's on the shot as an IN PROMPT reference, tagged with where it came from", rv[0].use === true && rv[0].fromCut.versionId === "v1a" && rv[0].fromCut.sourceDir === EP);
  await rem.useCutPart(R, "A", 0, false);
  const off = (await store.loadEpisode(R)).shots.find((x) => x.id === "A").refVideos;
  check("switching off keeps the clip but stops sending it", off.length === 1 && off[0].use === false && await exists(off[0].path));
  const again = await rem.useCutPart(R, "A", 0, true);
  check("switching on again reuses the clip (no second trim)", !again.made && (await store.loadEpisode(R)).shots.find((x) => x.id === "A").refVideos.length === 1);
  check("the source take and episode are untouched", (await hash(f.t1a)) === takeBefore && (await hash(`${EP}/studio.json`)) === srcBeforeRef);
  check("a non-remaster episode has no parts", !(await rem.cutParts(EP, "A")).remaster);
  // Leave A as it was for the checks below.
  await store.withEpisode(R, (e) => { e.shots.find((x) => x.id === "A").refVideos = []; });
}

console.log("\nadd back");
const ab = await rem.addBack(R, "B");
const ep2 = await store.loadEpisode(R);
check("a left-out shot comes back where it sat in the source (B between A and C)", ab.code === "1b" && ep2.shots.map((x) => x.id).join("") === "ABCD", ep2.shots.map((x) => x.id).join(""));
check("it has no target length (not in the cut)", ep2.shots.find((x) => x.id === "B").remaster.targetSeconds === null);
check("it leaves the left-out list", !ep2.remaster.leftOut.some((l) => l.shotId === "B"));
threw = null;
try { jobs.quote(ep2, { shotIds: ["B"], modelIds: ["minimax/h3/image-to-video"], seconds: "target" }); } catch (e) { threw = e; }
check("generating it by target asks for a duration instead", threw && /no target length/.test(threw.message));
threw = null;
try { await rem.addBack(R, "F"); } catch (e) { threw = e; }
check("a shot in the source's Cut from edit bin must be restored there first", threw && threw.status === 409);

console.log(`\n${fail === 0 ? "✓" : "✗"} remaster: ${pass} passed, ${fail} failed`);
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
process.exit(fail ? 1 : 0);
