// Undo restores which takes are selected, but never drops a paid take.
// (Before 2026-10-12, undo force-kept any selection pointing at a paid take,
// so "select take" could not be undone.)
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-undo-"));
process.env.RCS_PROJECT_ROOT = ROOT;
const store = await import("../server/store.js");
const { newEpisode, newShot } = await import("../shared/schema.js");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`); };

const EP = "S/E1";
await fs.mkdir(path.join(ROOT, EP), { recursive: true });
const ep = newEpisode({ name: "undo test", dir: EP });
const shot = newShot({ sceneNum: "1", shotCode: "a" });
shot.id = "A";
shot.versions = [{ id: "paid1", driver: "fal", state: "done", path: `${EP}/a.mp4` }];
shot.selectedVersions = [];
ep.shots = [shot];
await store.saveEpisode(EP, ep);

await store.withEpisode(EP, (e) => { e.shots[0].selectedVersions = ["paid1"]; e.shots[0].vidDone = true; }, { history: true });
check("take is selected", (await store.loadEpisode(EP)).shots[0].selectedVersions[0] === "paid1");
await store.undoEpisode(EP);
const after = (await store.loadEpisode(EP)).shots[0];
check("undo removes the selection", after.selectedVersions.length === 0, JSON.stringify(after.selectedVersions));
check("undo keeps the paid take itself", after.versions.some((v) => v.id === "paid1"));

console.log(`\n${fail === 0 ? "✓" : "✗"} undo-select: ${pass} passed, ${fail} failed`);
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
process.exit(fail ? 1 : 0);
