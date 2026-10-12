// "Use 0:03–0:07 of this take" (Shawn, 2026-10-09): a take's own in/out
// becomes the clip's head/tail trim on every rebuild, so the FCPXML carries it.
import { trimFromInOut, rebuildFromSelection } from "../server/timeline.js";
import { newEpisode, newShot, newTimeline } from "../shared/schema.js";
import { buildFCPXML } from "../server/export/fcpxml.js";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

const t = trimFromInOut({ inSec: 3, outSec: 7 }, 7.16);
check("3–7 of a 7.16 s take = head 3, tail 0.16", t.headTrimSec === 3 && t.tailTrimSec === 0.16, JSON.stringify(t));
check("no out = to the end", trimFromInOut({ inSec: 2, outSec: null }, 5).tailTrimSec === 0);
check("no in = from the start", trimFromInOut({ inSec: null, outSec: 4 }, 5).headTrimSec === 0);
check("out past the file is clamped", trimFromInOut({ inSec: 1, outSec: 99 }, 5).tailTrimSec === 0);

// Rebuild without touching disk: existing clips carry their probed duration.
const mk = (id, code, trims) => newShot({ id, sceneNum: "5", shotCode: code, versions: [{ id: `v${id}`, state: "done", path: `ep/takes/${code}.mp4`, seconds: 7 }], selectedVersions: [`v${id}`], takeTrims: trims });
const ep = newEpisode({ dir: "ep", shots: [mk("a", "a", {}), mk("b", "b", { vb: { inSec: 3, outSec: 7 } })], timeline: newTimeline() });
const v1 = ep.timeline.tracks.find((x) => x.id === "V1");
v1.clips = ["a", "b"].map((k) => ({ id: `c${k}`, shotId: k, versionId: `v${k}`, sourcePath: `ep/takes/${k}.mp4`, kind: "video", sourceDurationSec: 7.16, fps: 24, width: 768, height: 1344, hasAudio: true, headTrimSec: 0.5, tailTrimSec: 0.5, startSec: 0 }));
await rebuildFromSelection(ep);
const clips = ep.timeline.tracks.find((x) => x.id === "V1").clips;
const b = clips.find((c) => c.versionId === "vb"), a = clips.find((c) => c.versionId === "va");
check("the marked take is trimmed to 3–7 s (beats the old clip trims)", b.headTrimSec === 3 && b.tailTrimSec === 0.16, JSON.stringify(b));
check("an unmarked take keeps its existing trims", a.headTrimSec === 0.5 && a.tailTrimSec === 0.5);
check("the next shot starts where the marked part ends (6.16 + 0 offset)", Math.abs(b.startSec - 6.16) < 0.001, String(b.startSec));

const xml = buildFCPXML(ep.timeline, { V1: clips }, { projectName: "t", rootAbs: "/r", sequenceSize: { width: 1080, height: 1920 } });
const bLine = xml.split("\n").find((l) => l.includes("<asset-clip") && l.includes("5b"));
check("the FCPXML clip starts 3 s into the file and runs 4 s", /start="72\/24s"|start="3s"/.test(bLine) && /duration="96\/24s"|duration="4s"/.test(bLine), bLine);

console.log(`\n${fail ? "✗" : "✓"} take trims: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
