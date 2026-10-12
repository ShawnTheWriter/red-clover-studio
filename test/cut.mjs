// Reading an edited cut back from Resolve. Each fixture case is a shape found
// in Shawn's first real Resolve FCPXML (Fashion Heist S1E1_v2, 2026-10-07).

import path from "node:path";
import { parseXml, parseCut, flattenPicture, analyzeCut, rt } from "../server/cut.js";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const near = (a, b) => Math.abs(a - b) < 0.01;

const ROOT = "/proj";
const TAKES = "Show/S1E1/05_delivery/takes";
const url = (rel) => `file://${encodeURI(path.join(ROOT, rel))}`;
const asset = (id, file, { video = 1, audio = 1, dur = "120/24s" } = {}) =>
  `<asset id="${id}" name="${file}" start="0s" duration="${dur}" hasVideo="${video}" hasAudio="${audio}" format="r1"><media-rep kind="original-media" src="${url(file)}"/></asset>`;

// Shots: 1a (carryover, old name), 2a, 2b (two takes: lower one fully covered),
// 2c (cutaway over 2a), 2d (only on a clip hanging off a GAP), 3a (two takes
// back to back), 3b (video disabled, audio used), 3c (not in the timeline).
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
 <resources>
  <format id="r0" width="1080" height="1920" frameDuration="1/24s"/>
  <format id="r1" width="720" height="1280" frameDuration="1/24s"/>
  ${asset("a1", "Show/AI Source Clips/shot_01_old &amp; name.mp4")}
  ${asset("a2", `${TAKES}/9z_MiniMax-H3_v2a.mp4`)}
  ${asset("a3", `${TAKES}/2b_MiniMax-H3_v2bLow.mp4`)}
  ${asset("a4", `${TAKES}/2b_MiniMax-H3_v2bTop.mp4`)}
  ${asset("a5", `${TAKES}/2c_MiniMax-H3_v2c.mp4`)}
  ${asset("a6", `${TAKES}/2d_MiniMax-H3_v2d.mp4`)}
  ${asset("a7", `${TAKES}/3a_MiniMax-H3_v3a1.mp4`)}
  ${asset("a8", `${TAKES}/3a_MiniMax-H3_v3a2.mp4`)}
  ${asset("a9", `${TAKES}/3b_MiniMax-H3_v3b.mp4`)}
  ${asset("a10", "Elsewhere/unknown.mp4")}
 </resources>
 <library><event name="E"><project name="Cut">
  <sequence format="r0" duration="20s" tcStart="0s">
   <spine>
    <asset-clip ref="a2" offset="0s" start="0s" duration="4s" name="2a">
      <asset-clip ref="a5" lane="1" offset="1s" start="2s" duration="1s" name="2c"/>
    </asset-clip>
    <asset-clip ref="a3" offset="4s" start="0s" duration="3s" name="2b low">
      <asset-clip ref="a4" lane="1" offset="0s" start="1s" duration="3s" name="2b top"/>
      <asset-clip ref="a10" lane="2" offset="0s" start="0s" duration="1/24s" enabled="0" name="junk"/>
    </asset-clip>
    <gap offset="7s" start="3600s" duration="3s" name="Gap">
      <clip lane="1" offset="3601s" start="47/24s" duration="2s" name="2d">
        <video ref="a6" offset="0s" start="0s" duration="5s"/>
      </clip>
    </gap>
    <asset-clip ref="a7" offset="10s" start="1s" duration="2s" name="3a one"/>
    <asset-clip ref="a8" offset="12s" start="0s" duration="2s" name="3a two">
      <asset-clip ref="a9" lane="1" offset="0s" start="0s" duration="2s" enabled="0" name="3b pic off"/>
      <clip lane="-1" offset="0s" start="0s" duration="2s" name="3b sound">
        <audio ref="a9" offset="0s" start="0s" duration="5s"/>
      </clip>
    </asset-clip>
    <asset-clip ref="a1" offset="14s" start="1s" duration="6s" name="1a"/>
   </spine>
  </sequence>
 </project></event></library>
</fcpxml>`;

const shot = (sceneNum, shotCode, label, versions) => ({ id: `s${sceneNum}${shotCode}`, sceneNum, shotCode, label, versions, selectedVersions: versions.map((v) => v.id).slice(0, 1) });
const ver = (id, p) => ({ id, path: p, state: "done" });
const ep = {
  scenes: [{ number: "1" }, { number: "2" }, { number: "3" }, { number: "4" }],
  shots: [
    shot("1", "a", "carryover", [ver("zel", "Show/AI Source Clips/shot_01_old & name.mp4")]),
    shot("2", "a", "two a", [ver("v2a", `${TAKES}/9z_MiniMax-H3_v2a.mp4`)]),
    shot("2", "b", "two b", [ver("v2bLow", `${TAKES}/2b_MiniMax-H3_v2bLow.mp4`), ver("v2bTop", `${TAKES}/2b_MiniMax-H3_v2bTop.mp4`)]),
    shot("2", "c", "cutaway", [ver("v2c", `${TAKES}/2c_MiniMax-H3_v2c.mp4`)]),
    shot("2", "d", "on a gap", [ver("v2d", `${TAKES}/2d_MiniMax-H3_v2d.mp4`)]),
    shot("3", "a", "two takes", [ver("v3a1", `${TAKES}/3a_MiniMax-H3_v3a1.mp4`), ver("v3a2", `${TAKES}/3a_MiniMax-H3_v3a2.mp4`)]),
    shot("3", "b", "sound only", [ver("v3b", `${TAKES}/3b_MiniMax-H3_v3b.mp4`)]),
    shot("3", "c", "unused", [ver("v3c", `${TAKES}/3c_x_v3c.mp4`)]),
  ],
};

console.log("xml + time");
check("rational time", rt("1067/8s") === 133.375 && rt("0s") === 0 && rt("5s") === 5);
check("attribute entities decode", parseXml(`<a b="x &amp; y &#233;"/>`).children[0].attrs.b === "x & y é");
let threw = false;
try { parseXml("<a><b></a>"); } catch { threw = true; }
check("mismatched tags are refused", threw);

const parsed = parseCut(xml);
const a = analyzeCut(ep, parsed, ROOT);
const byCode = Object.fromEntries(a.shots.map((s) => [`${s.sceneNum}${s.code.slice(-1)}`, s]));

console.log("\nmapping");
check("take id in the file name wins over a stale shot code (9z -> 2a)", byCode["2a"].status === "in");
check("carryover matches on its full path, entities and spaces included", byCode["1a"].status === "in");
check("a file nobody owns is reported, not guessed", a.unmatched.length === 1 && a.unmatched[0].path.endsWith("Elsewhere/unknown.mp4"));

const moved = analyzeCut(ep, parseCut(xml.replaceAll("file:///proj/", "file:///other/root/")), ROOT);
check("carryover still matches when the project root moved", moved.shots.find((x) => x.shotId === "s1a").status === "in");

console.log("\nvisible picture");
check("a fully covered take is mess, not a part", byCode["2b"].parts.length === 1 && byCode["2b"].parts[0].versionId === "v2bTop");
check("the covered take is listed", a.covered.some((c) => c.versionId === "v2bLow"));
check("a disabled clip never counts as picture", !a.segments.some((s) => s.unmatched));
check("a clip hanging off a GAP is found", byCode["2d"].status === "in", JSON.stringify(byCode["2d"]));
check("its source in-point maps through <video>", near(byCode["2d"].parts[0].srcIn, 47 / 24));
check("its timeline position uses the gap's own start", near(byCode["2d"].firstAt, 8));
check("the uncovered part of the gap is the only gap", a.gaps.length === 1 && near(a.gaps[0].start, 7) && near(a.gaps[0].end, 8), JSON.stringify(a.gaps));
check("cutaway: 2a is one part spanning both sides of 2c", byCode["2a"].parts.length === 1 && near(byCode["2a"].parts[0].srcIn, 0) && near(byCode["2a"].parts[0].srcOut, 4));
check("cutaway: 2a's visible time excludes the cutaway", near(byCode["2a"].visibleSeconds, 3));
check("two takes back to back stay two parts", byCode["3a"].parts.length === 2);

console.log("\nstatus + scenes");
check("picture off, sound on = audio", byCode["3b"].status === "audio" && byCode["3b"].audioUses.length === 1);
check("not in the timeline = cut", byCode["3c"].status === "cut");
check("scene order is first appearance", JSON.stringify(a.sceneOrder) === JSON.stringify(["2", "3", "1"]), JSON.stringify(a.sceneOrder));
check("scenes with no picture are listed", JSON.stringify(a.scenesNotInCut) === JSON.stringify(["4"]));
check("sequence size and fps come from its format", a.sequence.width === 1080 && a.sequence.fps === 24 && a.sequence.duration === 20);

const flat = flattenPicture([{ kind: "video", enabled: true, tl: 0, dur: 1.1 + 2.2, srcIn: 0, lane: 0 }, { kind: "video", enabled: true, tl: 3.3, dur: 1, srcIn: 0, lane: 0 }], 4.3, 24);
check("float sums do not leave 1 ms gaps", !flat.segments.some((s) => s.gap), JSON.stringify(flat.segments));

console.log(`\n${fail === 0 ? "✓" : "✗"} cut import: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
