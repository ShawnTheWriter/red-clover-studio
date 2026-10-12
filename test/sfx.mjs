// Sound → SFX from picture. fal is replaced by a fake driver — no network,
// no spend. A real 5 s take is made with ffmpeg so probing is real.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-sfx-"));
process.env.RCS_PROJECT_ROOT = ROOT;
const store = await import("../server/store.js");
const sfx = await import("../server/sfx.js");
const jobs = await import("../server/jobs.js");
const timeline = await import("../server/timeline.js");
const { planSound, writeSoundCut } = await import("../server/soundcut.js");
const { parseCut, analyzeCut } = await import("../server/cut.js");
const { silentWav } = await import("../server/drivers/elevenlabs.js");

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const near = (a, b) => Math.abs(a - b) < 0.05;

const EP = "Show/S1E1", T = `${EP}/05_delivery/takes`;
await store.scaffold(EP);
await fs.mkdir(path.join(ROOT, T), { recursive: true });
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x568:rate=24:duration=5", "-f", "lavfi", "-i", "sine=duration=5", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(ROOT, `${T}/2a_M_vA.mp4`)]);
await store.saveEpisode(EP, {
  name: "S1E1", dir: EP, scenes: [{ number: "2", heading: "EXT. VILLAGE - NIGHT" }],
  shots: [{ id: "A", sceneNum: "2", shotCode: "a", label: "Overlock runs in the rain", action: "Overlock runs through the rain, hood up", beats: [], versions: [{ id: "vA", state: "done", path: `${T}/2a_M_vA.mp4` }], selectedVersions: ["vA"] }],
  ledger: { budgetCapUSD: 10, confirmAboveUSD: 5, spentUSD: 0, entries: [] },
});

console.log("prompt + quote");
let ep = await store.loadEpisode(EP);
const p = sfx.promptFor(ep, ep.shots[0]);
check("the default prompt carries the action and the slugline, under Kling's 200", p.startsWith("Overlock runs through the rain") && p.includes("EXT. VILLAGE - NIGHT") && p.length <= 200, p);
const qk = await sfx.quoteSfx(ep, { shotId: "A", model: "kling" });
const qm = await sfx.quoteSfx(ep, { shotId: "A", model: "mirelo" });
check("Kling is priced per video ($0.035)", qk.estimateUSD === 0.035 && near(qk.seconds, 5));
check("Mirelo is priced per second, both samples counted ($0.10 for 5 s)", qm.estimateUSD === 0.1, String(qm.estimateUSD));

console.log("\nmock runs");
const m1 = await sfx.generate(EP, { shotId: "A", model: "kling", driver: "mock" }, { drivers: jobs.drivers, ledgerState: jobs.ledgerState, enforceSpendGuards: jobs.enforceSpendGuards });
const m2 = await sfx.generate(EP, { shotId: "A", model: "mirelo", driver: "mock" }, { drivers: jobs.drivers, ledgerState: jobs.ledgerState, enforceSpendGuards: jobs.enforceSpendGuards });
ep = await store.loadEpisode(EP);
check("Kling makes one variant, Mirelo two (A and B)", m1.added.length === 1 && m2.added.length === 2 && m2.added[1].label.endsWith(" B"));
check("every variant is kept on the shot", ep.shots[0].sfx.takes.length === 3);
check("the first variant is in the edit by default", ep.shots[0].sfx.useId === m1.added[0].id);
check("mock runs cost nothing", ep.ledger.spentUSD === 0 && !ep.ledger.entries.length);

console.log("\nfal runs (fake driver)");
const calls = [];
const fakeFal = {
  status: () => ({ ready: true }),
  uploadFile: async (abs) => { calls.push(["upload", abs]); return "https://fal.test/in.mp4"; },
  runQueued: async (endpoint, input) => { calls.push(["run", endpoint, input]); return { requestId: "req1", result: { audio: { url: "https://fal.test/out.mp3" } } }; },
  download: async (url, abs) => { await fs.mkdir(path.dirname(abs), { recursive: true }); await fs.writeFile(abs, silentWav(5)); return abs; },
};
const deps = { drivers: { fal: fakeFal }, ledgerState: jobs.ledgerState, enforceSpendGuards: jobs.enforceSpendGuards };
const k = await sfx.generate(EP, { shotId: "A", model: "kling", driver: "fal" }, deps);
const run = calls.find((c) => c[0] === "run");
check("the upload is a silent copy, not the take itself", calls[0][1].endsWith("2a_silent.mp4"));
check("Kling gets the prompt and NO background music (its default is a car race)", run[1] === "fal-ai/kling-video/video-to-audio" && run[2].background_music_prompt === null && run[2].sound_effect_prompt.startsWith("Overlock"));
ep = await store.loadEpisode(EP);
check("a real run is charged to the ledger and counts against the cap", ep.ledger.spentUSD === 0.035 && ep.ledger.entries[0].kind === "sfx" && ep.ledger.entries[0].requestId === "req1");
check("the variant remembers its take and request", k.added[0].sourceVersionId === "vA" && k.added[0].requestId === "req1");
await store.withEpisode(EP, (e) => { e.ledger.spentUSD = 9.99; });
let threw = null;
try { await sfx.generate(EP, { shotId: "A", model: "mirelo", driver: "fal" }, deps); } catch (e) { threw = e; }
check("over the cap: refused before anything is uploaded", threw && /exceeds/.test(threw.message) && calls.filter((c) => c[0] === "upload").length === 1);
await store.withEpisode(EP, (e) => { e.ledger.spentUSD = 0.035; });
threw = null;
try { await sfx.generate(EP, { shotId: "A", model: "kling", prompt: "x".repeat(201), driver: "fal" }, deps); } catch (e) { threw = e; }
check("a Kling prompt over 200 characters is refused", threw && /200/.test(threw.message));

console.log("\nplacement");
ep = await store.loadEpisode(EP);
await timeline.rebuildFromSelection(ep);
const a2 = ep.timeline.tracks.find((t) => t.id === "A2").clips;
check("the in-edit variant lands on the app's SFX track (A2) at the take's start", a2.length === 1 && a2[0].startSec === 0 && a2[0].kind === "sfx");
// His cut shows the take from 2 s, at timeline 1 s.
const url = `file://${encodeURI(path.join(ROOT, `${T}/2a_M_vA.mp4`))}`;
const xml = `<?xml version="1.0"?><fcpxml version="1.10"><resources><format id="r1" width="1080" height="1920" frameDuration="1/24s"/><asset id="r2" name="2a" start="0s" duration="5s" hasVideo="1" hasAudio="1" format="r1"><media-rep kind="original-media" src="${url}"/></asset></resources><library><event name="E"><project name="P"><sequence format="r1" duration="4s"><spine><gap offset="0s" start="3600s" duration="1s" name="Gap"/><asset-clip ref="r2" offset="1s" start="2s" duration="3s" name="2a"/></spine></sequence></project></event></library></fcpxml>`;
const plan = planSound(ep, analyzeCut(ep, parseCut(xml), ROOT));
const f = plan.sfx[0];
check("on his cut: anchored to the take (2 s in at 1 s → file start at −1 s, head-trimmed 1 s)", f && f.at === 0 && near(f.inPoint, 1) && near(f.dur, 4), JSON.stringify(f));
const out = writeSoundCut(xml, plan, { root: ROOT, fps: 24 });
check("written as an RC SFX clip on its own lane", /name="RC SFX — 2a/.test(out.xml) && out.lanes.sfx === out.lanes.dialogue + 2);
check("a re-run replaces it", writeSoundCut(out.xml, plan, { root: ROOT, fps: 24 }).removed === 1);

console.log("\nundo never drops a paid variant");
await store.withEpisode(EP, (e) => { e.notes = "x"; }, { history: true });       // snapshot before the next paid run
await sfx.generate(EP, { shotId: "A", model: "kling", driver: "fal" }, deps);
const before = (await store.loadEpisode(EP)).shots[0].sfx.takes.length;
await store.undoEpisode(EP);
const after = (await store.loadEpisode(EP)).shots[0].sfx.takes.length;
check("after undo the newest paid variant is still there", after === before, `${before} → ${after}`);

console.log(`\n${fail === 0 ? "✓" : "✗"} sfx: ${pass} passed, ${fail} failed`);
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
process.exit(fail ? 1 : 0);
