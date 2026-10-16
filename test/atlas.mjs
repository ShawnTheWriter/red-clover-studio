// Atlas Cloud driver against a fake Atlas server: upload, submit fields,
// status handling, balance, and a full take through the job queue (cap,
// ledger, download). No real Atlas calls, no spend.

import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      ${detail}`}`); };

// ---- fake Atlas ----
const seen = { uploads: [], submits: [], polls: 0, auth: new Set() };
let pollPlan = ["processing", "completed"];
let balanceReply = { status: 200, body: { data: { balance: { value: "0.000000", currency: "usd" } } } };
const VIDEO = await fs.readFile(await (async () => {
  const p = path.join(os.tmpdir(), `rcs-atlas-src-${process.pid}.mp4`);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x568:rate=24:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", p]);
  return p;
})());
const srv = http.createServer(async (req, res) => {
  seen.auth.add(req.headers.authorization || "");
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/api/v1/model/uploadMedia" && req.method === "POST") {
    const ct = req.headers["content-type"] || "";
    seen.uploads.push({ ct, hasFileField: raw.includes(Buffer.from('name="file"')), bytes: raw.length });
    return json(200, { url: `https://files.atlas.test/u${seen.uploads.length}.bin` });
  }
  if (req.url === "/api/v1/model/generateVideo" && req.method === "POST") {
    seen.submits.push(JSON.parse(raw.toString()));
    return json(200, { code: 200, data: { id: `pred_${seen.submits.length}`, status: "processing" } });
  }
  if (req.url.startsWith("/api/v1/model/prediction/")) {
    const st = pollPlan[Math.min(seen.polls++, pollPlan.length - 1)];
    return json(200, { data: { id: req.url.split("/").pop(), status: st, outputs: st === "completed" ? [`http://127.0.0.1:${srv.address().port}/out.mp4`] : [], error: st === "failed" ? "Invalid parameter" : null } });
  }
  if (req.url === "/out.mp4") { res.writeHead(200, { "content-type": "video/mp4", "content-length": VIDEO.length }); return res.end(VIDEO); }
  if (req.url === "/public/v1/balance") return json(balanceReply.status, balanceReply.body);
  json(404, { error: "no route" });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-atlas-"));
process.env.RCS_PROJECT_ROOT = ROOT;
process.env.RCS_ATLAS_BASE_URL = `${BASE}/api/v1`;
process.env.RCS_ATLAS_PUBLIC_URL = `${BASE}/public/v1`;
process.env.RCS_PRICES_FILE = path.join(ROOT, "prices.json"); // never the app's real price cache
delete process.env.ATLAS_API_KEY;
const store = await import("../server/store.js");
const jobs = await import("../server/jobs.js");
const { videoModel, VIDEO_MODELS } = await import("../server/rates.js");
const { AtlasDriver } = await import("../server/drivers/atlas.js");
// env.js loads the app's .env on import: never let a real key reach a test.
delete process.env.ATLAS_API_KEY; jobs.drivers.atlas.key = "";

const img = path.join(ROOT, "frame.png");
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=576x1024", "-frames:v", "1", img]);
const I2V = "atlas:bytedance/seedance-2.5/image-to-video", REF = "atlas:bytedance/seedance-2.5/reference-to-video";

console.log("model rows");
check("Atlas rows exist and run on the atlas driver", videoModel(I2V)?.driver === "atlas" && videoModel(REF)?.driver === "atlas");
check("fal rows have no driver set (stay on fal)", VIDEO_MODELS.filter((m) => !m.id.startsWith("atlas:") && !m.id.startsWith("comfy:")).every((m) => !m.driver));
check("routing: an Atlas row goes to atlas, a fal row to fal, a rehearsal stays mock", jobs.driverForModel(I2V, "fal") === "atlas" && jobs.driverForModel("minimax/h3/image-to-video", "fal") === "fal" && jobs.driverForModel(I2V, "mock") === "mock");

console.log("\ndriver");
const d = new AtlasDriver({ key: "atl-test-key-1234" });
check("not ready without a key", !new AtlasDriver().status().ready);
const sub = await d.generateVideo({ imagePath: img, endImagePath: img, aspectRatio: "9:16", prompt: "she turns", seconds: 6, modelId: I2V });
const b1 = seen.submits[0];
check("start and end frames uploaded as multipart 'file'", seen.uploads.length === 2 && seen.uploads.every((u) => /multipart\/form-data/.test(u.ct) && u.hasFileField));
check("i2v body: Atlas model id, image + last_image, number duration, 720p, adaptive", b1.model === "bytedance/seedance-2.5/image-to-video" && b1.image && b1.last_image && b1.duration === 6 && b1.resolution === "720p" && b1.ratio === "adaptive" && b1.prompt === "she turns", JSON.stringify(b1));
check("bearer key sent", seen.auth.has("Bearer atl-test-key-1234"));
check("returns the prediction id", sub.jobId === "pred_1");
const r1 = await d.getJob({ jobId: sub.jobId, statusUrl: sub.statusUrl });
const r2 = await d.getJob({ jobId: sub.jobId, statusUrl: sub.statusUrl });
check("processing → running, completed → done with the output url", r1.state === "running" && r2.state === "done" && /out\.mp4$/.test(r2.result.videoUrl), JSON.stringify([r1, r2.state]));
pollPlan = ["failed"]; seen.polls = 0;
const r3 = await d.getJob({ jobId: "x" });
check("failed → error with Atlas's reason", r3.state === "error" && /Invalid parameter/.test(r3.error));
await d.generateVideo({ referencePaths: [img, img], referenceVideoPaths: [path.join(os.tmpdir(), `rcs-atlas-src-${process.pid}.mp4`)], aspectRatio: "9:16", prompt: "@Image1 walks", seconds: 5, modelId: REF });
const b2 = seen.submits[1];
check("reference body: reference_images + reference_videos, ratio from the episode", b2.model === "bytedance/seedance-2.5/reference-to-video" && b2.reference_images.length === 2 && b2.reference_videos.length === 1 && b2.ratio === "9:16", JSON.stringify(b2));
const bal = await d.balance();
check("balance read ($0 on an unfunded account)", bal.usd === 0, JSON.stringify(bal));
balanceReply = { status: 401, body: { error: { message: "bad key" } } };
let threw = null; try { await d.balance(); } catch (e) { threw = e; }
check("a rejected key surfaces as 401", threw && threw.status === 401);

console.log("\nthrough the job queue");
const DIR = "Show/E1";
await store.scaffold(DIR);
await fs.copyFile(img, path.join(ROOT, DIR, "03_storyboard", "a.png"));
await store.saveEpisode(DIR, {
  name: "E1", dir: DIR, fmt: "9:16",
  shots: [{ id: "s1", sceneNum: "1", shotCode: "a", label: "turn", move: "static", action: "She turns.", beats: [{ id: "b1", keyframe: true, role: "start", frame: { path: `${DIR}/03_storyboard/a.png`, approved: true } }], versions: [], selectedVersions: [] }],
  ledger: { budgetCapUSD: 10, confirmAboveUSD: 5, spentUSD: 0, entries: [] },
});
threw = null;
try { await jobs.submitFanOut(DIR, { shotIds: ["s1"], modelIds: [I2V], seconds: 5, driver: "fal" }); } catch (e) { threw = e; }
check("refused while Atlas isn't connected (nothing created)", threw && /atlas" not ready/.test(threw.message) && !(await store.loadEpisode(DIR)).shots[0].versions.length, threw && threw.message);
jobs.drivers.atlas.key = "atl-test-key-1234";
jobs.drivers.atlas.base = `${BASE}/api/v1`;
pollPlan = ["processing", "completed"]; seen.polls = 0;
const out = await jobs.submitFanOut(DIR, { shotIds: ["s1"], modelIds: [I2V], seconds: 5, driver: "fal" });
check("the take is queued on the atlas driver at the Atlas price", out.versions[0].driver === "atlas" && Math.abs(out.versions[0].estimateUSD - 1.65) < 0.01, JSON.stringify(out.versions[0]));
let v = null;
for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 500)); v = (await store.loadEpisode(DIR)).shots[0].versions[0]; if (v.state === "done" || v.state === "error") break; }
check("it lands: downloaded into takes/ with the model code in the name", v.state === "done" && /05_delivery\/takes\/1a_.*SD25atl_/.test(v.path), JSON.stringify(v));
const led = (await store.loadEpisode(DIR)).ledger;
check("charged at the estimate in the ledger, driver atlas", led.entries.length === 1 && led.entries[0].driver === "atlas" && Math.abs(led.spentUSD - 1.65) < 0.01, JSON.stringify(led));

console.log("\nprice watch");
const pw = await import("../server/pricewatch.js");
let asked = "";
process.env.FAL_KEY = "fal-test";
await pw.checkPrices({ fetchImpl: async (url) => { asked = String(url); return { ok: true, json: async () => ({ prices: [] }), status: 200 }; } }).catch(() => {});
check("fal's price check never asks about Atlas rows", asked.includes("minimax") && !asked.includes("atlas"), asked.slice(0, 200));
delete process.env.FAL_KEY;

srv.close();
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
console.log(`\n${fail === 0 ? "✓" : "✗"} atlas: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
