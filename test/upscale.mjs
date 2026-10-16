// Upscale-take tests — pricing, quote (incl. the trimmed span), validation, the
// shared spend guards, the queue path (mock driver), the fal request bodies
// (fetch stubbed) and the conform step (real ffmpeg on tiny generated clips).
// No network, no spend.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-upscale-"));
process.env.RCS_PROJECT_ROOT = ROOT;

const store = await import("../server/store.js");
const jobs = await import("../server/jobs.js");
const rates = await import("../server/rates.js");
const { trimmedCopy, normalizeUpscaled } = await import("../server/upscale.js");
const { probe } = await import("../server/ffprobe.js");
const { FalDriver } = await import("../server/drivers/fal.js");
const { newEpisode, newShot } = await import("../shared/schema.js");

jobs.drivers.mock.billable = true;
jobs.drivers.mock.latencyMs = 200;
jobs.drivers.mock.failRate = 0;

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const rejects = async (name, fn, re) => {
  try { await fn(); fail++; console.log(`  ✗ ${name}\n      expected a refusal, got success`); }
  catch (e) {
    if (!re || re.test(e.message)) { pass++; console.log(`  ✓ ${name} (${e.message.slice(0, 90)})`); }
    else { fail++; console.log(`  ✗ ${name}\n      wrong refusal: ${e.message}`); }
  }
};

const SEED = "fal-ai/seedvr/upscale/video", BD = "fal-ai/bytedance-upscaler/upscale/video";

console.log("\nPRICING");
{
  const sv = rates.estimateUpscaleUSD(SEED, { seconds: 11, fps: 24 });
  check("SeedVR2: 11 s at 24 fps = $0.001 x 2.0736 MP x 264 frames ≈ $0.547 (fal billed $0.548)", Math.abs(sv.usd - 0.548) < 0.002, String(sv.usd));
  check("SeedVR2 is marked measured (fal billed 548 MP = $0.548 for the 11 s run)", sv.confidence === "measured");
  const bd = rates.estimateUpscaleUSD(BD, { seconds: 11 });
  check("Bytedance: 11 s x $0.0072 = $0.0792, exact", Math.abs(bd.usd - 0.0792) < 1e-9 && bd.confidence === "exact");
  check("a 30 fps take costs 25% more on SeedVR2 (per frame)", Math.abs(rates.estimateUpscaleUSD(SEED, { seconds: 10, fps: 30 }).usd / rates.estimateUpscaleUSD(SEED, { seconds: 10, fps: 24 }).usd - 1.25) < 1e-9);
  await rejects("an unknown model is refused", async () => rates.estimateUpscaleUSD("nope/x", { seconds: 5 }), /unknown upscale model/);
  await rejects("a non-positive duration is refused", async () => rates.estimateUpscaleUSD(SEED, { seconds: 0 }), /invalid duration/);
  check("480x854 snaps to exactly 1080x1920", JSON.stringify(rates.upscaleOutputSize(480, 854)) === '{"width":1080,"height":1920}');
  check("854x480 snaps to exactly 1920x1080", JSON.stringify(rates.upscaleOutputSize(854, 480)) === '{"width":1920,"height":1080}');
  check("file names use the short model code", rates.modelShort(SEED) === "SeedVR2" && rates.modelShort(BD) === "BDUp");
}

const DIR = "Scratch/S1E01";
await store.scaffold(DIR);
await fs.mkdir(store.safeResolve(DIR, "05_delivery/takes"), { recursive: true });
await fs.writeFile(store.safeResolve(DIR, "05_delivery/takes/src.mp4"), "video");

const mkTake = (id, over = {}) => ({
  id, shotId: "S1", modelId: "bytedance/seedance-2.5/reference-to-video", modelLabel: "Seedance 2.5 draft", driver: "atlas",
  seconds: 12, billable: true, estimateUSD: 1.6, actualUSD: 1.6, state: "done", error: null,
  jobId: "j", path: `${DIR}/05_delivery/takes/src.mp4`, ...over,
});
const shot = newShot({ id: "S1", sceneNum: "1", shotCode: "a", move: "push" });
shot.versions = [mkTake("T12"), mkTake("TRUN", { state: "running", path: null }), mkTake("TSTR", { seconds: "10.0" }), mkTake("TLONG", { seconds: 60 }), mkTake("TCUT")];
shot.selectedVersions = ["T12"];
shot.takeTrims = { T12: { inSec: 0, outSec: 5 }, TSTR: { inSec: 2, outSec: null }, TLONG: { inSec: 0, outSec: 60 }, TCUT: { inSec: null, outSec: null, cuts: [{ startSec: 5, endSec: 6.04 }] } };
let ep = newEpisode({ name: "Scratch", dir: DIR, shots: [shot] });
ep.ledger = { budgetCapUSD: 25, confirmAboveUSD: 2, spentUSD: 0, entries: [] };
await store.saveEpisode(DIR, ep);
const opts = (over = {}) => ({ versionId: "T12", modelId: BD, driver: "mock", ...over });

console.log("\nQUOTE — priced on the seconds actually sent");
{
  ep = await store.loadEpisode(DIR);
  const q = jobs.quoteUpscale(ep, opts());
  check("a trimmed take (0 to 5 of 12 s) is priced on 5 s: $0.04", q.seconds === 5 && q.totalUSD === 0.04, JSON.stringify([q.seconds, q.totalUSD]));
  check("the quote carries the kept span and the full length", q.spans && q.spans.length === 1 && q.spans[0].inSec === 0 && q.spans[0].outSec === 5 && q.fullSeconds === 12);
  const qw = jobs.quoteUpscale(ep, opts({ useTrim: false }));
  check("ignoring the trim prices the whole 12 s", qw.seconds === 12 && qw.spans === null && qw.totalUSD === 0.09, JSON.stringify([qw.seconds, qw.totalUSD]));
  const qc = jobs.quoteUpscale(ep, opts({ versionId: "TCUT" }));
  check("a take with a cut-out (5.0 to 6.04 of 12 s) is priced on the 10.96 s that is kept, as two spans", qc.seconds === 10.96 && qc.spans.length === 2 && qc.spans[0].outSec === 5 && qc.spans[1].inSec === 6.04, JSON.stringify([qc.seconds, qc.spans]));
  const qi = jobs.quoteUpscale(ep, opts({ versionId: "TSTR" }));
  check("an open-ended trim (from 2 s) on an imported take with string seconds ('10.0') prices 8 s", qi.seconds === 8, String(qi.seconds));
  const qs = jobs.quoteUpscale(ep, opts({ modelId: SEED }));
  check("SeedVR2 on 5 s ≈ $0.25 and needs no confirmation", qs.totalUSD === 0.25 && qs.needsConfirmation === false, JSON.stringify([qs.totalUSD, qs.needsConfirmation]));
  const ql = jobs.quoteUpscale(ep, opts({ versionId: "TLONG", modelId: SEED }));
  check("60 s of SeedVR2 (≈ $2.99) needs confirmation", ql.needsConfirmation === true && ql.totalUSD > 2, String(ql.totalUSD));
}

console.log("\nINPUT VALIDATION");
{
  ep = await store.loadEpisode(DIR);
  await rejects("a take that hasn't finished can't be upscaled", async () => jobs.quoteUpscale(ep, opts({ versionId: "TRUN" })), /hasn't finished/);
  await rejects("an unknown take is refused", async () => jobs.quoteUpscale(ep, opts({ versionId: "ghost" })), /take not found/);
  await rejects("an unknown model is refused", async () => jobs.quoteUpscale(ep, opts({ modelId: "nope" })), /unknown upscale model/);
  await rejects("an unsupported target is refused", async () => jobs.quoteUpscale(ep, opts({ target: "8k" })), /target must be/);
}

console.log("\nSPEND GUARDS — the same two as every paid take");
{
  await rejects("over the confirm threshold with no confirmation is refused", async () => jobs.submitUpscale(DIR, opts({ versionId: "TLONG", modelId: SEED })), /Confirmation required/);
  await store.withEpisode(DIR, (e) => { e.ledger.budgetCapUSD = 0.01; });
  await rejects("over the hard cap is refused outright", async () => jobs.submitUpscale(DIR, opts()), /exceeds/);
  await store.withEpisode(DIR, (e) => { e.ledger.budgetCapUSD = 25; });
  ep = await store.loadEpisode(DIR);
  check("none of those refusals queued anything", ep.shots[0].versions.length === 5, String(ep.shots[0].versions.length));
}

console.log("\nQUEUE PATH — a mock-driven run");
{
  const before = (await store.loadEpisode(DIR)).ledger.spentUSD;
  const { version } = await jobs.submitUpscale(DIR, opts());
  check("returns a queued upscale take pointing at its source", version.op === "upscale" && version.sourceVersionId === "T12" && version.state === "queued");
  check("records the kept span, the target and the seconds actually sent", version.spans && version.spans[0].outSec === 5 && version.target === "1080p" && version.seconds === 5);
  check("its label says what it is", /Upscale 1080p \(Bytedance/.test(version.modelLabel) && /Seedance 2\.5 draft/.test(version.modelLabel), version.modelLabel);
  let done = null;
  for (let i = 0; i < 40 && !done; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const e = await store.loadEpisode(DIR);
    const v = e.shots[0].versions.find((x) => x.id === version.id);
    if (v && (v.state === "done" || v.state === "error")) done = v;
  }
  check("finishes done with a file whose name has the model code and version id", done && done.state === "done" && /_BDUp_/.test(done.path) && done.path.includes(done.id), JSON.stringify(done && [done.state, done.error, done.path]));
  const e2 = await store.loadEpisode(DIR);
  check("charged the estimate exactly once ($0.04)", Math.abs(e2.ledger.spentUSD - before - 0.04) < 0.005, String(e2.ledger.spentUSD - before));
  const entry = e2.ledger.entries[e2.ledger.entries.length - 1];
  check("ledger entry names the upscale model and take", entry.model === BD && entry.versionId === version.id);
  check("the source take is untouched", e2.shots[0].versions.find((v) => v.id === "T12").path.endsWith("src.mp4"));
  check("the new take is NOT auto-selected", JSON.stringify(e2.shots[0].selectedVersions) === '["T12"]');
}

console.log("\nFAL REQUESTS — what each model is sent (fetch stubbed)");
{
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ request_id: "r1", status_url: "https://queue.fal.run/x/requests/r1/status", response_url: "https://queue.fal.run/x/requests/r1" }), { status: 200 });
  };
  try {
    const d = new FalDriver({ key: "test-key" });
    d.uploadFile = async () => "https://fal.media/up.mp4";
    const a = await d.generateUpscale({ videoPath: "/x.mp4", modelId: SEED, target: "1080p", fps: 24 });
    const b = await d.generateUpscale({ videoPath: "/x.mp4", modelId: BD, target: "1080p", fps: 24 });
    const c = await d.generateUpscale({ videoPath: "/x.mp4", modelId: BD, target: "1080p", fps: 30 });
    check("SeedVR2 body: target mode at 1080p, high quality", sent[0].url.endsWith("/" + SEED) && sent[0].body.upscale_mode === "target" && sent[0].body.target_resolution === "1080p" && sent[0].body.output_quality === "high" && sent[0].body.video_url === "https://fal.media/up.mp4");
    check("Bytedance body: 1080p, AI-video preset, standard tier, source frame rate (24)", sent[1].body.target_resolution === "1080p" && sent[1].body.enhancement_preset === "aigc" && sent[1].body.enhancement_tier === "standard" && sent[1].body.target_fps === 24);
    check("Bytedance is never sent the pro tier (10x price)", sent.every((s) => !s.body || s.body.enhancement_tier !== "pro"));
    check("a 30 fps source is asked for 30 fps", sent[2].body.target_fps === 30);
    check("returns the queue handles from the submit response", a.jobId === "r1" && a.statusUrl.endsWith("/status") && !!b.responseUrl && !!c.jobId);
    await rejects("an unknown model has no request mapping", async () => d.generateUpscale({ videoPath: "/x.mp4", modelId: "nope", target: "1080p" }), /unknown upscale model/);
  } finally { globalThis.fetch = realFetch; }
}

console.log("\nCONFORM — the result is matched to its source (real ffmpeg)");
{
  const T = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-upconform-"));
  const ff = (...a) => run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a]);
  const frames = async (f) => Number((await run("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", f])).stdout.trim());
  const src = path.join(T, "src.mp4");
  await ff("-f", "lavfi", "-i", "testsrc=size=480x854:rate=24:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src);
  // SeedVR2's habit: same frame count, 23 fps, 1088x1936, no sound.
  const up = path.join(T, "up.mp4");
  await ff("-i", src, "-vf", "scale=1088:1936,setpts=N/(23*TB)", "-r", "23", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", up);
  const before = await probe(up);
  check("fixture: the fake upscale really is 23 fps, 1088x1936, silent", Math.round(before.fps) === 23 && before.width === 1088 && !before.hasAudio, JSON.stringify(before));
  const n0 = await frames(up);
  const res = await normalizeUpscaled(up, { srcAbs: src });
  const after = await probe(up);
  check("reports what it fixed: frame rate, size and audio", res.fps && res.size && res.audio, JSON.stringify(res));
  check("now 24 fps, exactly 1080x1920, with the source's audio", Math.round(after.fps) === 24 && after.width === 1080 && after.height === 1920 && after.hasAudio, JSON.stringify(after));
  check("the same number of frames (no drift, no drops)", (await frames(up)) === n0, `${n0} → ${await frames(up)}`);
  check("duration now matches the source within a frame", Math.abs(after.durationSec - (await probe(src)).durationSec) < 0.1, `${after.durationSec}`);
  const again = await normalizeUpscaled(up, { srcAbs: src });
  check("a file that already matches is left alone", again.none === true);

  // A trimmed run: the file that was SENT is the trimmed copy, and the result
  // is matched to it (the sound comes from that span only).
  const sent = await trimmedCopy(src, [{ inSec: 1, outSec: 2 }]);
  const sp = await probe(sent);
  check("trimmedCopy cuts the requested span (1 s) and keeps the sound", Math.abs(sp.durationSec - 1) < 0.15 && sp.hasAudio, JSON.stringify(sp));
  const up2 = path.join(T, "up2.mp4");
  await ff("-ss", "1", "-t", "1", "-i", src, "-vf", "scale=1080:1920", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", up2);
  const r2 = await normalizeUpscaled(up2, { srcAbs: sent });
  const a2 = await probe(up2);
  check("a trimmed upscale gets only that span's audio", r2.audio && a2.hasAudio && Math.abs(a2.durationSec - 1) < 0.15, JSON.stringify([r2, a2.durationSec]));
  await fs.rm(sent, { force: true });

  // Two kept spans (cut out 1 s to 2 s of the 3 s clip) become one 2 s clip, picture and sound together.
  const two = await trimmedCopy(src, [{ inSec: 0, outSec: 1 }, { inSec: 2, outSec: 3 }]);
  const tp = await probe(two);
  check("two spans are joined into one clip of the kept length (2 s) with sound", Math.abs(tp.durationSec - 2) < 0.2 && tp.hasAudio && tp.width === 480, JSON.stringify(tp));
  check("the joined clip has 48 frames at 24 fps (2 s)", Math.abs((await frames(two)) - 48) <= 1, String(await frames(two)));
  await fs.rm(two, { force: true });
}

console.log(`\n${fail ? "✗" : "✓"} upscale tests: ${pass} passed, ${fail} failed`);
await fs.rm(ROOT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
