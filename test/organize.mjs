// "Organize folders and footage from XML", end to end on real files in a temp
// root: preview, apply, relinked FCPXML, reverse. No project data, no spend.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-organize-"));
process.env.RCS_PROJECT_ROOT = ROOT;
process.env.RCS_RESOLVE_SCRIPTS_DIR = path.join(ROOT, "_resolve-scripts"); // never the real Resolve menu
const store = await import("../server/store.js");
const org = await import("../server/organize.js");
const { relinkFcpxml } = org;

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const exists = (rel) => fs.access(path.join(ROOT, rel)).then(() => true, () => false);
const write = async (rel, body = rel) => { await fs.mkdir(path.dirname(path.join(ROOT, rel)), { recursive: true }); await fs.writeFile(path.join(ROOT, rel), body); };
const read = (rel) => fs.readFile(path.join(ROOT, rel), "utf8");

const EP = "Show/S1E1";
const T = `${EP}/05_delivery/takes`, SB = `${EP}/03_storyboard`;
await store.scaffold(EP);

// Script scenes 1..3. The cut plays scene 2 first, then scene 1. Scene 3 has
// no shots. Shot 1b is cut. 2a and 2b swap order in the cut (a rename chain:
// 2a's file becomes 2b's name and the other way round). 1c is new work with
// no take. A storyboard is shared by 1a and 1b. A carryover lives outside the
// episode folder and must not move.
const files = {
  t1a: `${T}/1a_MiniMax-H3_v1a.mp4`, t1b: `${T}/1b_MiniMax-H3_v1b.mp4`,
  t2a: `${T}/2a_MiniMax-H3_v2a.mp4`, t2b: `${T}/2b_MiniMax-H3_v2b.mp4`,
  s1a: `${SB}/01a_wide.png`, s1b: `${SB}/01b_only-b.png`, s2a: `${SB}/2A rooftop.png`, s2b: `${SB}/close up.png`,
  carry: "Show/AI Source Clips/shot_09_old.mp4",
};
for (const f of Object.values(files)) await write(f);
// A file already named like 2b's new storyboard target, owned by nobody.
await write(`${SB}/02a_rooftop.png`, "squatter");

const beat = (p) => ({ id: `b${Math.random().toString(36).slice(2, 7)}`, keyframe: true, role: "start", frame: { path: p, approved: true } });
const shot = (id, sceneNum, shotCode, versions, beats) => ({ id, sceneNum, shotCode, label: id, versions, selectedVersions: versions.slice(0, 1).map((v) => v.id), beats });
const ver = (id, p) => ({ id, path: p, state: "done", driver: "fal" });
const ep = {
  name: "S1E1", dir: EP,
  scenes: [{ id: "c1", number: "1", heading: "INT. ONE" }, { id: "c2", number: "2", heading: "EXT. TWO" }, { id: "c3", number: "3", heading: "INT. THREE" }],
  shots: [
    shot("A", "1", "a", [ver("v1a", files.t1a)], [beat(files.s1a)]),
    shot("B", "1", "b", [ver("v1b", files.t1b)], [beat(files.s1a), beat(files.s1b)]),
    shot("C", "1", "c", [], []),
    shot("D", "2", "a", [ver("v2a", files.t2a)], [beat(files.s2a)]),
    shot("E", "2", "b", [ver("v2b", files.t2b)], [beat(files.s2b)]),
    shot("F", "2", "c", [ver("v09", files.carry)], []),
  ],
  ledger: { budgetCapUSD: 10, confirmAboveUSD: 2, spentUSD: 0, entries: [] },
};
await store.saveEpisode(EP, ep);
// Some undo history exists before the organize.
await store.withEpisode(EP, (e) => { e.notes = "before"; }, { history: true });

const url = (rel) => `file://${encodeURI(path.join(ROOT, rel))}`;
const asset = (id, rel) => `<asset id="${id}" name="${path.basename(rel)}" start="0s" duration="5s" hasVideo="1" hasAudio="1" format="r1"><media-rep kind="original-media" src="${url(rel)}"/></asset>`;
const xml = `<?xml version="1.0"?><fcpxml version="1.10"><resources><format id="r1" width="1080" height="1920" frameDuration="1/24s"/>
${asset("a", files.t1a)}${asset("d", files.t2a)}${asset("e", files.t2b)}${asset("f", files.carry)}</resources>
<library><event name="E"><project name="P"><sequence format="r1" duration="8s"><spine>
<asset-clip ref="e" offset="0s" start="0s" duration="2s"/>
<asset-clip ref="d" offset="2s" start="0s" duration="2s"/>
<asset-clip ref="f" offset="4s" start="0s" duration="2s"/>
<asset-clip ref="a" offset="6s" start="0s" duration="2s"/>
</spine></sequence></project></event></library></fcpxml>`;
const XML = `${EP}/05_delivery/cut.fcpxml`;
await write(XML, xml);

console.log("preview");
const pv = await org.previewOrganize(EP, XML);
const to = (id) => pv.shots.find((s) => s.shotId === id);
check("scene 2 plays first, so it becomes scene 1", pv.scenes.find((s) => s.from === "2").to === "1");
check("scene 1 becomes scene 2", pv.scenes.find((s) => s.from === "1").to === "2");
check("scene 3 has no shots but is kept, after the cut scenes", pv.scenes.find((s) => s.from === "3").to === "3");
check("shot order inside a scene follows the cut (2b first)", to("E").toCode === "1a" && to("D").toCode === "1b");
check("a shot with takes but nothing in the cut goes to the bin", to("B").toScene === "X");
check("a shot with no take yet is new work and stays in its scene", to("C").toScene === "2");
check("preview wrote nothing", await exists(files.t2a) && (await read(`${EP}/studio.json`)).includes(files.t2a));
const rn = (from) => pv.renames.find((r) => r.from === from);
check("takes get the bare new code", rn(files.t2b)?.to === `${T}/1a_MiniMax-H3_v2b.mp4`);
check("storyboards get the padded new code", rn(files.s2b)?.to === `${SB}/01a_close up.png`);
check("an existing file is never overwritten", rn(files.s2a)?.to === `${SB}/01b_rooftop.png`, rn(files.s2a)?.to);
check("a storyboard shared with a binned shot stays with the kept shot", rn(files.s1a)?.to === `${SB}/02a_wide.png`);
check("files only a binned shot uses go to the archive", rn(files.s1b)?.to === `${EP}/_archive/cut/03_storyboard/01b_only-b.png` && rn(files.t1b)?.reason === "archive");
check("files outside the episode folder are never moved", !rn(files.carry));

console.log("\napply");
let threw = null;
try { await org.applyOrganize(EP, XML, "stale"); } catch (e) { threw = e; }
check("a plan that differs from the preview is refused", threw && threw.status === 409);
const res = await org.applyOrganize(EP, XML, pv.planHash);
const after = await store.loadEpisode(EP);
const s = (id) => after.shots.find((x) => x.id === id);
check("files moved", await exists(`${T}/1a_MiniMax-H3_v2b.mp4`) && !(await exists(files.t2b)));
check("the swap did not lose a file", (await read(`${T}/1b_MiniMax-H3_v2a.mp4`)) === files.t2a && (await read(`${T}/1a_MiniMax-H3_v2b.mp4`)) === files.t2b);
check("the squatter file is untouched", (await read(`${SB}/02a_rooftop.png`)) === "squatter");
check("take paths in studio.json follow the files", s("E").versions[0].path === `${T}/1a_MiniMax-H3_v2b.mp4`);
check("storyboard paths follow, on every shot that shares them", s("A").beats[0].frame.path === `${SB}/02a_wide.png` && s("B").beats[0].frame.path === `${SB}/02a_wide.png`);
check("shot codes match the cut", `${s("E").sceneNum}${s("E").shotCode}` === "1a" && `${s("A").sceneNum}${s("A").shotCode}` === "2a");
check("binned shot is marked and remembers its old code", s("B").sceneNum === "X" && s("B").cutFromEdit?.fromCode === "1b");
check("binned shots sit at the end of the array", after.shots[after.shots.length - 1].id === "B");
check("scenes keep the script number", after.scenes.find((c) => c.id === "c2").number === "1" && after.scenes.find((c) => c.id === "c2").scriptNumber === "2");
check("old undo history moved out of the episode", !(await exists(`${EP}/.history`)) && await exists(`${res.organizeFolder}/history`));
const relinked = await read(res.relinked);
check("relinked FCPXML points at the new names", relinked.includes(encodeURI(path.join(ROOT, `${T}/1a_MiniMax-H3_v2b.mp4`))) && !relinked.includes(encodeURI(path.join(ROOT, files.t2b))));
check("relinked FCPXML leaves the carryover path alone", relinked.includes(encodeURI(path.join(ROOT, files.carry))));
check("the bins script is refreshed with the new codes", res.binsScript && !res.binsScript.error && (await read("_resolve-scripts/Red Clover - Scene bins (S1E1).lua")).includes("1a_MiniMax-H3_v2b.mp4"));
check("Shawn's own XML is not modified", (await read(XML)) === xml);

console.log("\nreverse");
await store.withEpisode(EP, (e) => { e.notes = "edited after"; });
threw = null;
try { await org.reverseOrganize(EP); } catch (e) { threw = e; }
check("reverse is refused after a later edit", threw && threw.status === 409);
check("…and moved nothing", await exists(`${T}/1a_MiniMax-H3_v2b.mp4`));
// Put the file back to its post-organize bytes so reverse is allowed.
const map = JSON.parse(await read(`${res.organizeFolder}/map.json`));
await store.withEpisode(EP, (e) => { e.notes = "before"; });
map.afterHash = (await import("node:crypto")).createHash("sha256").update(await read(`${EP}/studio.json`)).digest("hex").slice(0, 16);
await fs.writeFile(path.join(ROOT, `${res.organizeFolder}/map.json`), JSON.stringify(map));
const rv = await org.reverseOrganize(EP);
const back = await store.loadEpisode(EP);
check("reverse puts every file back", rv.restoredFiles === pv.renames.length && await exists(files.t2b) && await exists(files.s1b) && await exists(files.t2a));
check("reverse restores the episode", back.shots.find((x) => x.id === "E").versions[0].path === files.t2b && back.shots.find((x) => x.id === "B").sceneNum === "1");
check("reverse restores the undo history", await exists(`${EP}/.history`));
check("reverse parks the stale relinked FCPXML in the organize folder", !(await exists(res.relinked)) && await exists(`${res.organizeFolder}/${path.basename(res.relinked)}`));
check("a reversed organize is not offered again", (await org.lastOrganize(EP)) === null);

console.log("\nrelink unit");
const r = relinkFcpxml(`<media-rep src="file:///a/b%20c.mp4"/><media-rep src="file:///keep.mp4"/>`, new Map([["/a/b c.mp4", "/a/new & d.mp4"]]));
check("relink encodes the new path and escapes &", r.changed === 1 && r.xml.includes(`src="file:///a/new%20&amp;%20d.mp4"`), r.xml);

console.log(`\n${fail === 0 ? "✓" : "✗"} organize: ${pass} passed, ${fail} failed`);
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
process.exit(fail ? 1 : 0);
