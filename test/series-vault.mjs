// Series vault: cards stored once in series.json, merged into every episode,
// edits from any episode reach the series, episode files never hold them.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-svault-"));
process.env.RCS_PROJECT_ROOT = ROOT;
const store = await import("../server/store.js");
const { newEpisode, newSeries, newAsset } = await import("../shared/schema.js");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`); };
const readRaw = async (rel) => JSON.parse(await fs.readFile(path.join(ROOT, rel), "utf8"));

await fs.mkdir(path.join(ROOT, "Show/E1"), { recursive: true });
await fs.mkdir(path.join(ROOT, "Show/E2"), { recursive: true });
const series = newSeries({ name: "Show", registry: [{ id: "ph1", type: "character", name: "Mei", approved: true }] });
await store.saveSeries("Show", series);
await store.saveEpisode("Show/E1", newEpisode({ name: "E1", dir: "Show/E1" }));
await store.saveEpisode("Show/E2", newEpisode({ name: "E2", dir: "Show/E2" }));

check("series folder is found", (await store.seriesDirOf("Show/E1")) === "Show");
check("placeholders are not merged as cards", (await store.loadEpisode("Show/E1")).assets.length === 0);

await store.withEpisode("Show/E1", (ep) => { ep.assets.push(Object.assign(newAsset({ type: "character", name: "Jun", identityHold: "Keep this exact character: grey coat." }), { id: "c1", fromSeries: true, vault: true })); });
check("series card is not written into the episode file", (await readRaw("Show/E1/studio.json")).assets.length === 0);
check("series card is written to series.json", (await readRaw("Show/series.json")).registry.some((r) => r.id === "c1" && r.vault));
const e2 = await store.loadEpisode("Show/E2");
check("another episode sees the series card", e2.assets.some((a) => a.id === "c1" && a.fromSeries));

await store.withEpisode("Show/E2", (ep) => { ep.assets.find((a) => a.id === "c1").identityHold = "Keep this exact character: red coat."; });
check("an edit from episode 2 reaches the series", (await readRaw("Show/series.json")).registry.find((r) => r.id === "c1").identityHold.includes("red coat"));
check("episode 1 sees the edit", (await store.loadEpisode("Show/E1")).assets.find((a) => a.id === "c1").identityHold.includes("red coat"));

await store.withEpisode("Show/E1", (ep) => { ep.assets = ep.assets.filter((a) => a.id !== "c1"); });
check("deleting inside an episode does not remove it from the series", (await store.loadEpisode("Show/E1")).assets.some((a) => a.id === "c1"));

await fs.mkdir(path.join(ROOT, "Solo"), { recursive: true });
await store.saveEpisode("Solo", newEpisode({ name: "Solo", dir: "Solo" }));
check("a standalone episode has no series", (await store.seriesDirOf("Solo")) === null && (await store.loadEpisode("Solo")).assets.length === 0);

console.log(`\n${fail === 0 ? "✓" : "✗"} series-vault: ${pass} passed, ${fail} failed`);
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
process.exit(fail ? 1 : 0);
