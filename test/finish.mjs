// Atlas draft → finish (Shawn, 2026-10-16), and the audio switch. Against a
// fake Atlas server: the draft request (draft:true, 480p, sound on/off), the
// draft id and 7-day window kept on the take, the finish quote and its
// refusals, the finish request (only the draft id), the guards and the ledger.
// No real Atlas calls, no spend.

import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      ${detail}`}`); };
const rejects = async (name, fn, re) => {
  try { await fn(); fail++; console.log(`  ✗ ${name}\n      expected a refusal, got success`); }
  catch (e) { if (!re || re.test(e.message)) { pass++; console.log(`  ✓ ${name} (${e.message.slice(0, 80)})`); } else { fail++; console.log(`  ✗ ${name}\n      wrong refusal: ${e.message}`); } }
};

const seen = { submits: [], polls: 0 };
const VIDEO = await fs.readFile(await (async () => {
  const p = path.join(os.tmpdir(), `rcs-finish-src-${process.pid}.mp4`);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x568:rate=24:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", p]);
  return p;
})());
const srv = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/api/v1/model/uploadMedia") return json(200, { url: "https://files.atlas.test/u.bin" });
  if (req.url === "/api/v1/model/generateVideo" && req.method === "POST") {
    seen.submits.push(JSON.parse(raw.toString()));
    return json(200, { code: 200, data: { id: `pred_${seen.submits.length}`, status: "processing" } });
  }
  if (req.url.startsWith("/api/v1/model/prediction/")) {
    const st = seen.polls++ % 2 === 0 ? "processing" : "completed";
    return json(200, { data: { id: req.url.split("/").pop(), status: st, outputs: st === "completed" ? [`http://127.0.0.1:${srv.address().port}/out.mp4`] : [] } });
  }
  if (req.url === "/out.mp4") { res.writeHead(200, { "content-type": "video/mp4", "content-length": VIDEO.length }); return res.end(VIDEO); }
  json(404, { error: "no route" });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-finish-"));
process.env.RCS_PROJECT_ROOT = ROOT;
process.env.RCS_ATLAS_BASE_URL = `${BASE}/api/v1`;
process.env.RCS_ATLAS_PUBLIC_URL = `${BASE}/public/v1`;
process.env.RCS_PRICES_FILE = path.join(ROOT, "prices.json");
delete process.env.ATLAS_API_KEY;
const store = await import("../server/store.js");
const jobs = await import("../server/jobs.js");
const rates = await import("../server/rates.js");
delete process.env.ATLAS_API_KEY; jobs.drivers.atlas.key = "";
jobs.drivers.atlas.key = "atl-test-key-1234";
jobs.drivers.atlas.base = `${BASE}/api/v1`;

const I2V = "atlas:bytedance/seedance-2.5/image-to-video", I2V_DRAFT = `${I2V}@480p`, REF_DRAFT = "atlas:bytedance/seedance-2.5/reference-to-video@480p";
const FIN = "atlas:bytedance/seedance-2.5/draft-complete";

console.log("model rows");
{
  const d1 = rates.videoModel(I2V_DRAFT), d2 = rates.videoModel(REF_DRAFT);
  check("both Atlas 480p rows are drafts, finishable by the draft-complete row", d1.draft && d2.draft && d1.finishModel === FIN && d2.finishModel === FIN);
  check("a draft is sent draft:true at 480p (Atlas overrides the resolution)", d1.atlas.fixed.draft === true && d1.atlas.fixed.resolution === "480p" && d2.atlas.fixed.draft === true);
  check("draft price is the MEASURED $0.134/s (19 s cost $2.5447)", d1.usdPerVideoSecond === 0.134 && d1.confidence === "measured" && Math.abs(19 * 0.134 - 2.5447) < 0.01);
  check("labels say 480p draft and Atlas", /480p draft.*Atlas/.test(d1.label) && /480p draft.*Atlas/.test(d2.label), d1.label);
  check("every Atlas Seedance row has the sound switch; no fal row does", rates.VIDEO_MODELS.filter((m) => m.driver === "atlas").every((m) => m.audioSwitch) && rates.VIDEO_MODELS.filter((m) => !m.driver).every((m) => !m.audioSwitch));
  check("the 720p Atlas rows are not drafts", !rates.videoModel(I2V).draft && !rates.videoModel("atlas:bytedance/seedance-2.5/reference-to-video").draft);
  const f = rates.estimateFinishUSD(FIN, 12);
  check("finish: 12 s x $0.263 = $3.156 (an estimate from Atlas's page)", Math.abs(f.usd - 3.156) < 1e-9 && f.confidence === "estimated");
  check("file name code for a finish take", rates.modelShort(FIN) === "SD25fin");
}

const img = path.join(ROOT, "frame.png");
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=576x1024", "-frames:v", "1", img]);
const DIR = "Show/E1";
await store.scaffold(DIR);
await fs.copyFile(img, path.join(ROOT, DIR, "03_storyboard", "a.png"));
await store.saveEpisode(DIR, {
  name: "E1", dir: DIR, fmt: "9:16",
  shots: [{ id: "s1", sceneNum: "1", shotCode: "a", label: "turn", move: "static", action: "She turns.", beats: [{ id: "b1", keyframe: true, role: "start", frame: { path: `${DIR}/03_storyboard/a.png`, approved: true } }], versions: [], selectedVersions: [] }],
  ledger: { budgetCapUSD: 10, confirmAboveUSD: 2, spentUSD: 0, entries: [] },
});
const waitDone = async (id) => {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const v = (await store.loadEpisode(DIR)).shots[0].versions.find((x) => x.id === id);
    if (v && (v.state === "done" || v.state === "error")) return v;
  }
  return null;
};
const ver = async (id) => (await store.loadEpisode(DIR)).shots[0].versions.find((x) => x.id === id);

console.log("\nthe draft, and the sound switch");
let draft, quiet, mockTake;
{
  const o = await jobs.submitFanOut(DIR, { shotIds: ["s1"], modelIds: [I2V_DRAFT], seconds: 6, driver: "fal" });
  draft = await waitDone(o.versions[0].id);
  const b = seen.submits[0];
  check("the draft request: Atlas i2v model, draft true, 480p, sound on by default", b.model === "bytedance/seedance-2.5/image-to-video" && b.draft === true && b.resolution === "480p" && b.generate_audio === true && b.duration === 6, JSON.stringify(b));
  check("the draft lands done on the atlas driver at $0.80 (6 s x $0.134)", draft && draft.state === "done" && draft.driver === "atlas" && Math.abs(draft.estimateUSD - 0.8) < 0.01, JSON.stringify(draft && [draft.state, draft.error, draft.estimateUSD]));
  check("it keeps its draft id (the Atlas prediction id)", draft.draftId === "pred_1" && draft.jobId === "pred_1");
  const days = (Date.parse(draft.draftExpiresAt) - Date.now()) / 864e5;
  check("and a 7-day window to finish it", days > 6.99 && days <= 7.001, String(days));
  const o2 = await jobs.submitFanOut(DIR, { shotIds: ["s1"], modelIds: [I2V_DRAFT], seconds: 4, driver: "fal", audio: false });
  quiet = await waitDone(o2.versions[0].id);
  check("sound off: generate_audio false in the request, the take remembers it", seen.submits[1].generate_audio === false && quiet.audio === false, JSON.stringify(seen.submits[1]));
  check("sound off costs the same per second ($0.134 x 4 = $0.54)", Math.abs(quiet.estimateUSD - 0.54) < 0.01, String(quiet.estimateUSD));
  const o3 = await jobs.submitFanOut(DIR, { shotIds: ["s1"], modelIds: ["minimax/h3/image-to-video"], seconds: 5, driver: "mock", audio: false });
  check("a model without the switch ignores it (nothing stored on the take)", o3.versions[0].audio === undefined);
  mockTake = await waitDone(o3.versions[0].id);
}

console.log("\nQUOTE — finish");
{
  const ep = await store.loadEpisode(DIR);
  const q = jobs.quoteFinish(ep, { versionId: draft.id });
  check("6 s finish quotes $1.58 (6 x $0.263)", q.totalUSD === 1.58 && q.seconds === 6, JSON.stringify([q.totalUSD, q.seconds]));
  check("it shows the draft's cost and both together ($0.80 + $1.58)", q.draftUSD === 0.8 && q.bothUSD === 2.38, JSON.stringify([q.draftUSD, q.bothUSD]));
  check("and the days left (7)", q.daysLeft === 7 && !!q.expiresAt, JSON.stringify([q.daysLeft, q.expiresAt]));
  check("an estimate, under the $2 confirmation threshold", q.confidence === "estimated" && q.needsConfirmation === false);
}

console.log("\nREFUSALS");
{
  const ep = await store.loadEpisode(DIR);
  await rejects("a take that is not a draft can't be finished", async () => jobs.quoteFinish(await store.loadEpisode(DIR), { versionId: mockTake.id }), /only an Atlas 480p draft/);
  await rejects("an unknown take is refused", async () => jobs.quoteFinish(ep, { versionId: "ghost" }), /take not found/);
  await rejects("an unknown finish model is refused", async () => jobs.quoteFinish(ep, { versionId: draft.id, modelId: "nope" }), /unknown finish model/);
  await store.withEpisode(DIR, (e) => { const v = e.shots[0].versions.find((x) => x.id === quiet.id); v.draftExpiresAt = new Date(Date.now() - 864e5).toISOString(); });
  await rejects("a draft past its 7 days is refused, with the date", async () => jobs.quoteFinish(await store.loadEpisode(DIR), { versionId: quiet.id }), /stopped being finishable on \d{4}-\d{2}-\d{2}/);
}

console.log("\nSPEND GUARDS");
{
  await store.withEpisode(DIR, (e) => { e.ledger.budgetCapUSD = e.ledger.spentUSD + 0.5; });
  await rejects("over the hard cap is refused outright", async () => jobs.submitFinish(DIR, { versionId: draft.id, driver: "atlas" }), /exceeds/);
  await store.withEpisode(DIR, (e) => { e.ledger.budgetCapUSD = 10; e.ledger.confirmAboveUSD = 1; });
  await rejects("over the confirm threshold with no confirmation is refused", async () => jobs.submitFinish(DIR, { versionId: draft.id, driver: "atlas" }), /Confirmation required/);
  check("none of those refusals queued anything", (await store.loadEpisode(DIR)).shots[0].versions.filter((v) => v.op === "finish").length === 0);
  await store.withEpisode(DIR, (e) => { e.ledger.confirmAboveUSD = 2; });
}

console.log("\nTHE FINISH — a take made from the draft");
{
  const before = (await store.loadEpisode(DIR)).ledger.spentUSD;
  const nSubmits = seen.submits.length;
  const { version } = await jobs.submitFinish(DIR, { versionId: draft.id, driver: "atlas" });
  check("a queued finish take pointing at its draft", version.op === "finish" && version.sourceVersionId === draft.id && version.draftId === "pred_1" && version.state === "queued");
  check("its label and the prompt it inherited are shown", /Finish 1080p \(Atlas\)/.test(version.modelLabel) && version.prompt === draft.prompt, version.modelLabel);
  const done = await waitDone(version.id);
  const b = seen.submits[nSubmits];
  check("the request carries ONLY the draft-complete model and the draft id", b.model === "bytedance/seedance-2.5/draft-complete" && b.draft_id === "pred_1" && Object.keys(b).length === 2, JSON.stringify(b));
  check("it lands done with a file named with the finish code", done && done.state === "done" && /_SD25fin_/.test(done.path), JSON.stringify(done && [done.state, done.error, done.path]));
  const e2 = await store.loadEpisode(DIR);
  check("charged $1.58 once, on the atlas driver", Math.abs(e2.ledger.spentUSD - before - 1.58) < 0.005 && e2.ledger.entries[e2.ledger.entries.length - 1].model === FIN, String(e2.ledger.spentUSD - before));
  check("the draft is untouched and still finishable", e2.shots[0].versions.find((v) => v.id === draft.id).state === "done");
  check("the finish is NOT auto-selected", e2.shots[0].selectedVersions.length === 0);
  const again = await jobs.submitFinish(DIR, { versionId: draft.id, driver: "atlas" });
  const done2 = await waitDone(again.version.id);
  check("a draft can be finished a second time within its window", done2 && done2.state === "done" && seen.submits[seen.submits.length - 1].draft_id === "pred_1");
  await rejects("a finish take is not itself a draft to finish", async () => jobs.quoteFinish(await store.loadEpisode(DIR), { versionId: version.id }), /only an Atlas 480p draft/);
}

srv.close();
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
console.log(`\n${fail === 0 ? "✓" : "✗"} finish: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
