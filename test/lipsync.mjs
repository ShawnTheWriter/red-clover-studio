// Lip-sync tests — pricing, the shared spend guards, and the queue path.
// Scratch episode in a temp root, mock driver: no network, no spend.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-lipsync-"));
process.env.RCS_PROJECT_ROOT = ROOT;

const store = await import("../server/store.js");
const jobs = await import("../server/jobs.js");
const { estimateLipsyncUSD, LIPSYNC_MODELS } = await import("../server/rates.js");
const { newEpisode, newShot } = await import("../shared/schema.js");

// The mock stands in for a real billed backend here so the ledger path is the
// same one fal takes; the last section flips it back to prove it bills nothing.
jobs.drivers.mock.billable = true;
jobs.drivers.mock.latencyMs = 200;

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const rejects = async (name, fn, re) => {
  try { await fn(); fail++; console.log(`  ✗ ${name}\n      expected a refusal, got success`); }
  catch (e) {
    const ok = !re || re.test(e.message);
    if (ok) { pass++; console.log(`  ✓ ${name} (${e.message.slice(0, 90)})`); }
    else { fail++; console.log(`  ✗ ${name}\n      wrong refusal: ${e.message}`); }
  }
};

const DIR = "Scratch/S1E01";
await store.scaffold(DIR);
await fs.mkdir(store.safeResolve(DIR, "05_delivery/takes"), { recursive: true });
await fs.writeFile(store.safeResolve(DIR, "05_delivery/takes/src.mp4"), "video");
await fs.writeFile(store.safeResolve(DIR, "05_delivery/takes/pending.mp4"), "video");

const mkTake = (id, over = {}) => ({
  id, shotId: "S1", modelId: "minimax/h3/image-to-video", modelLabel: "MiniMax H3", driver: "fal",
  seconds: 10, billable: true, estimateUSD: 1.3, actualUSD: 1.3, state: "done", error: null,
  jobId: "j", path: `${DIR}/05_delivery/takes/src.mp4`, ...over,
});
const shot = newShot({ id: "S1", sceneNum: "1", shotCode: "a", move: "push" });
shot.versions = [mkTake("T10"), mkTake("T20", { seconds: 20 }), mkTake("TRUN", { state: "running", path: null }), mkTake("TSTR", { seconds: "5.0" })];
shot.selectedVersions = ["T10"];
shot.audioClips = [{ id: "A1", label: "Overlock line 1", path: `${DIR}/05_delivery/audio/dialogue/l1.wav`, seconds: 4.2 }];
let ep = newEpisode({ name: "Scratch", dir: DIR, shots: [shot] });
ep.ledger = { budgetCapUSD: 25, confirmAboveUSD: 2, spentUSD: 0, entries: [] };
await store.saveEpisode(DIR, ep);

const SYNC3 = "fal-ai/sync-lipsync/v3", PRO = "fal-ai/sync-lipsync/v2/pro";
const opts = (over = {}) => ({ versionId: "T10", audioClipId: "A1", modelId: SYNC3, driver: "mock", ...over });

console.log("\nPRICING — per minute of source video");
check("sync-3 is $8/min: 60s prices at exactly $8", Math.abs(estimateLipsyncUSD(SYNC3, 60).usd - 8) < 1e-9);
check("Sync 2 Pro is $5/min: 30s prices at $2.50", Math.abs(estimateLipsyncUSD(PRO, 30).usd - 2.5) < 1e-9);
check("both listed models are marked exact", LIPSYNC_MODELS.every((m) => m.confidence === "exact"));
await rejects("an unknown model is refused, not silently priced", async () => estimateLipsyncUSD("nope/nope", 5), /unknown lip-sync model/);
await rejects("a non-positive duration is refused", async () => estimateLipsyncUSD(SYNC3, -3), /invalid duration/);

console.log("\nQUOTE");
{
  ep = await store.loadEpisode(DIR);
  const q = jobs.quoteLipsync(ep, opts());
  check("10s take on sync-3 quotes $1.33", q.totalUSD === 1.33, String(q.totalUSD));
  check("under the $2 threshold: no confirmation needed", q.needsConfirmation === false);
  const q2 = jobs.quoteLipsync(ep, opts({ versionId: "T20" }));
  check("20s take quotes $2.67 and needs confirmation", q2.totalUSD === 2.67 && q2.needsConfirmation === true, JSON.stringify([q2.totalUSD, q2.needsConfirmation]));
  const q3 = jobs.quoteLipsync(ep, opts({ versionId: "TSTR" }));
  check("an imported take's string seconds ('5.0') still price correctly", q3.seconds === 5 && q3.totalUSD === 0.67, JSON.stringify([q3.seconds, q3.totalUSD]));
}

console.log("\nINPUT VALIDATION");
{
  ep = await store.loadEpisode(DIR);
  await rejects("a take that hasn't finished can't be lip-synced", async () => jobs.quoteLipsync(ep, opts({ versionId: "TRUN" })), /hasn't finished/);
  await rejects("an audio clip that isn't on the shot is refused", async () => jobs.quoteLipsync(ep, opts({ audioClipId: "ghost" })), /audio clip not found/);
  await rejects("an unknown take is refused", async () => jobs.quoteLipsync(ep, opts({ versionId: "ghost" })), /take not found/);
  await rejects("a bad sync mode is refused before anything is queued", async () => jobs.submitLipsync(DIR, opts({ syncMode: "warp" })), /sync mode must be/);
}

console.log("\nSPEND GUARDS — the same two as a fan-out");
{
  await rejects("over the confirm threshold with no confirmation is refused", async () => jobs.submitLipsync(DIR, opts({ versionId: "T20" })), /Confirmation required/);
  await rejects("a mismatched echoed total is refused", async () => jobs.submitLipsync(DIR, opts({ versionId: "T20", confirmedUSD: 1.0 })), /confirmed \$1\.00 but/);
  await rejects("a non-numeric confirmation is refused", async () => jobs.submitLipsync(DIR, opts({ versionId: "T20", confirmedUSD: "yes" })), /Refused/);
  await store.withEpisode(DIR, (e) => { e.ledger.budgetCapUSD = 1; });
  await rejects("over the hard cap is refused outright", async () => jobs.submitLipsync(DIR, opts()), /exceeds/);
  await store.withEpisode(DIR, (e) => { e.ledger.budgetCapUSD = 25; });
  ep = await store.loadEpisode(DIR);
  check("none of those refusals queued anything", ep.shots[0].versions.length === 4, String(ep.shots[0].versions.length));
}

console.log("\nQUEUE PATH — a real (mock-driven) run");
{
  const before = (await store.loadEpisode(DIR)).ledger.spentUSD;
  const { version, quote } = await jobs.submitLipsync(DIR, opts({ syncMode: "remap" }));
  check("returns a queued lip-sync take pointing at its source", version.op === "lipsync" && version.sourceVersionId === "T10" && version.state === "queued");
  check("records the sync mode, audio clip and its own copy of the audio path", version.syncMode === "remap" && version.audioClipId === "A1" && version.audioPath.endsWith("l1.wav"));
  check("in-flight spend counts against the cap immediately", jobs.ledgerState(await store.loadEpisode(DIR)).inFlightUSD >= 1.33);

  let done = null;
  for (let i = 0; i < 40 && !done; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const e = await store.loadEpisode(DIR);
    const v = e.shots[0].versions.find((x) => x.id === version.id);
    if (v && (v.state === "done" || v.state === "error")) done = v;
  }
  check("finishes done with a file path", done && done.state === "done" && !!done.path, JSON.stringify(done && [done.state, done.error]));
  const e2 = await store.loadEpisode(DIR);
  check("charged the estimate to the ledger exactly once", Math.abs(e2.ledger.spentUSD - before - 1.33) < 0.005, String(e2.ledger.spentUSD - before));
  const entry = e2.ledger.entries[e2.ledger.entries.length - 1];
  check("ledger entry names the lip-sync model and take", entry.model === SYNC3 && entry.versionId === version.id);
  check("the source take is untouched", e2.shots[0].versions.find((v) => v.id === "T10").path.endsWith("src.mp4"));
  check("the new take is NOT auto-selected (Shawn picks after watching)", JSON.stringify(e2.shots[0].selectedVersions) === '["T10"]');
}

console.log("\nNON-BILLING DRIVER");
{
  jobs.drivers.mock.billable = false;
  const before = (await store.loadEpisode(DIR)).ledger.spentUSD;
  const { version } = await jobs.submitLipsync(DIR, opts());
  check("a non-billing driver reserves nothing", version.billable === false && version.estimateUSD === 0);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const v = (await store.loadEpisode(DIR)).shots[0].versions.find((x) => x.id === version.id);
    if (v.state === "done" || v.state === "error") break;
  }
  check("and charges nothing when it finishes", (await store.loadEpisode(DIR)).ledger.spentUSD === before);
}

await fs.rm(ROOT, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✓" : "✗"} lip sync: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
