// Sume driver against a fake Sume server: upload (presigned, no key), submit
// bodies per row, status mapping, cancel, balance, a full take through the job
// queue (a failed job is NOT charged), the live public price list, and how Sume
// rows compete with fal and Atlas on cheapest route. No real Sume calls, no spend.

import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      ${detail}`}`); };

const seen = { signs: [], puts: [], submits: [], headers: [], auth: new Set(), cancels: 0, putAuth: [] };
let jobsListStatus = 200;
let plan = ["queued", "processing", "completed"], polls = 0, cancelReply = 200, balanceReply = { status: 200, body: { data: { balance: { available_credits: 1500, available_usd: "15.00", state: "funded" } } } };
const clip = path.join(os.tmpdir(), `rcs-sume-src-${process.pid}.mp4`);
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x568:rate=24:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
const VIDEO = await fs.readFile(clip);
const srv = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const url = req.url.split("?")[0];
  if (url.startsWith("/put/")) { seen.putAuth.push(req.headers.authorization || ""); seen.puts.push({ bytes: raw.length, ct: req.headers["content-type"] }); res.writeHead(200); return res.end(); }
  seen.auth.add(req.headers.authorization || "");
  if (url === "/v1/files/generate-upload-url") {
    const b = JSON.parse(raw.toString()); seen.signs.push(b);
    const n = seen.signs.length;
    return json(201, { data: { upload_url: `${BASE}/put/${n}`, upload_method: "PUT", upload_headers: {}, public_url: `https://media.sume.test/u${n}`, content_type: b.content_type, expires_at: "2099-01-01T00:00:00Z", asset_id: `a${n}` } });
  }
  if (url === "/v1/video-router/generate") {
    seen.submits.push(JSON.parse(raw.toString())); seen.headers.push(req.headers);
    const id = `job_${seen.submits.length}`;
    return json(202, { data: { request_id: id, job: { id, status: "queued" }, status_url: `${BASE}/v1/jobs/${id}/status`, result_url: `${BASE}/v1/jobs/${id}/result`, cancel_url: `${BASE}/v1/jobs/${id}/cancel`, cancelable: true } });
  }
  let m;
  if ((m = url.match(/^\/v1\/jobs\/([^/]+)\/status$/))) {
    const st = plan[Math.min(polls++, plan.length - 1)];
    return json(200, { data: { job_id: m[1], sume_status: st, terminal: ["completed", "failed", "canceled"].includes(st) } });
  }
  if ((m = url.match(/^\/v1\/jobs\/([^/]+)\/result$/))) return json(200, { data: { job_id: m[1], status: "COMPLETED", result: { artifacts: [{ id: "x", url: `${BASE}/out.mp4`, type: "video", content_type: "video/mp4" }] } } });
  if ((m = url.match(/^\/v1\/jobs\/([^/]+)\/cancel$/))) { seen.cancels++; return json(cancelReply, cancelReply === 200 ? { data: { canceled: true } } : { error: { code: "job_generation_already_started" } }); }
  if ((m = url.match(/^\/v1\/jobs\/([^/]+)$/))) return json(200, { data: { job: { id: m[1], status: "failed", error: { message: "provider rejected the input" } } } });
  if (url === "/v1/balance") return json(balanceReply.status, balanceReply.body);
  if (url === "/v1/jobs") return json(jobsListStatus, { data: { jobs: [] } });
  if (url === "/out.mp4") { res.writeHead(200, { "content-type": "video/mp4", "content-length": VIDEO.length }); return res.end(VIDEO); }
  json(404, { error: "no route" });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-sume-"));
process.env.RCS_PROJECT_ROOT = ROOT;
process.env.RCS_SUME_BASE_URL = BASE;
process.env.RCS_PRICES_FILE = path.join(ROOT, "prices.json");
process.env.RCS_SETTINGS_FILE = path.join(ROOT, "settings.json");
const store = await import("../server/store.js");
const jobs = await import("../server/jobs.js");
const R = await import("../server/rates.js");
const { SumeDriver } = await import("../server/drivers/sume.js");
delete process.env.SUME_API_KEY; jobs.drivers.sume.key = ""; // env.js loads the app's .env: never let a real key reach a test

const img = path.join(ROOT, "frame.png");
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=576x1024", "-frames:v", "1", img]);
const SD25 = "sume:seedance-2.5/image-to-video@720p", SD25R = "sume:seedance-2.5/reference-to-video@720p";
const H3 = "sume:minimax-h3/image-to-video@768P", H3MR = "sume:minimax-h3-max/reference-to-video@768P";

console.log("model rows");
check("Sume rows exist and run on the sume driver", R.videoModel(SD25)?.driver === "sume" && R.videoModel(SD25)?.via === "sume" && R.videoModel(H3MR)?.driver === "sume");
check("prices are the Sume list: 2.5 720p $0.2312, H3 768p $0.06, 2.0 Mini 480p $0.04", R.videoModel(SD25).usdPerVideoSecond === 0.2312 && R.videoModel(H3).usdPerVideoSecond === 0.06 && R.videoModel("sume:seedance-2-mini/image-to-video@480p").usdPerVideoSecond === 0.04);
check("every Sume row shares coordinates with a fal row (same model, same resolution)", R.VIDEO_MODELS.filter((m) => m.driver === "sume").every((m) => R.VIDEO_MODELS.some((f) => (f.via || "fal") === "fal" && f.family === m.family && f.mode === m.mode && (f.tier || null) === (m.tier || null) && f.res === m.res)));
check("the H3 Max reference row (frames + refs in one request, untried on Sume) is opt-in", R.videoModel(H3MR).optIn === true);
check("a rehearsal on a Sume row stays a mock; otherwise sume", jobs.driverForModel(SD25, "mock") === "mock" && jobs.driverForModel(SD25, "fal") === "sume");

console.log("\ndriver");
const d = new SumeDriver({ key: "sume-test-key-1234", base: BASE });
check("not ready without a key", !new SumeDriver({ key: "" }).status().ready);
const sub = await d.generateVideo({ imagePath: img, endImagePath: img, aspectRatio: "9:16", prompt: "she turns", seconds: 6, modelId: SD25 });
const b1 = seen.submits[0];
check("images are signed, then PUT without the API key", seen.signs.length === 2 && seen.signs.every((s) => /^image\/(png|jpeg)$/.test(s.content_type) && s.size_bytes > 0) && seen.puts.length === 2 && seen.putAuth.every((a) => a === ""), JSON.stringify([seen.signs, seen.putAuth]));
check("frames body: model, image_url + end_image_url, integer duration, 720p, 9:16, async", b1.model === "seedance-2.5" && /^https:\/\/media\.sume\.test\//.test(b1.image_url) && /^https:\/\/media\.sume\.test\//.test(b1.end_image_url) && b1.duration === 6 && b1.resolution === "720p" && b1.aspect_ratio === "9:16" && b1.mode === "async" && b1.prompt === "she turns" && !("generate_audio" in b1), JSON.stringify(b1));
check("bearer key and an idempotency key sent on the submit", seen.auth.has("Bearer sume-test-key-1234") && /^[0-9a-f-]{36}$/.test(seen.headers[0]["idempotency-key"] || ""));
check("returns the job id and the status address", sub.jobId === "job_1" && /\/v1\/jobs\/job_1\/status$/.test(sub.statusUrl));
const g = [await d.getJob({ jobId: sub.jobId, statusUrl: sub.statusUrl, responseUrl: sub.responseUrl }), await d.getJob({ jobId: sub.jobId, statusUrl: sub.statusUrl }), await d.getJob({ jobId: sub.jobId, statusUrl: sub.statusUrl, responseUrl: sub.responseUrl })];
check("queued → queued, processing → running, completed → done with the artifact url", g[0].state === "queued" && g[1].state === "running" && g[2].state === "done" && /out\.mp4$/.test(g[2].result.videoUrl), JSON.stringify(g.map((x) => x.state)));
plan = ["failed"]; polls = 0;
const f = await d.getJob({ jobId: "job_9" });
check("failed → error that says nothing was billed, flagged noCharge, with Sume's reason", f.state === "error" && f.noCharge === true && /provider rejected the input/.test(f.error) && /refund/i.test(f.error), JSON.stringify(f));
const n0 = seen.submits.length;
await d.generateVideo({ referencePaths: [img, img], referenceVideoPaths: [clip], aspectRatio: "16:9", prompt: "@Image1 walks", seconds: 5, modelId: SD25R, audio: false });
const b2 = seen.submits[n0];
check("reference body: reference_image_urls + reference_video_urls, no start frame, 16:9, sound off", b2.model === "seedance-2.5" && b2.reference_image_urls.length === 2 && b2.reference_video_urls.length === 1 && !("image_url" in b2) && b2.aspect_ratio === "16:9" && b2.generate_audio === false, JSON.stringify(b2));
await d.generateVideo({ imagePath: img, aspectRatio: "9:16", prompt: "turn", seconds: 5, modelId: H3, audio: false });
const b3 = seen.submits[n0 + 1];
check("H3 body: model minimax-h3, resolution 768p, NO aspect_ratio and NO generate_audio (H3 rejects the toggle)", b3.model === "minimax-h3" && b3.resolution === "768p" && !("aspect_ratio" in b3) && !("generate_audio" in b3), JSON.stringify(b3));
const bal = await d.balance();
check("balance read in dollars", bal.usd === 15, JSON.stringify(bal));
balanceReply = { status: 401, body: { error: {} } };
let threw = null; try { await d.balance(); } catch (e) { threw = e; }
check("a rejected key surfaces as 401", threw && threw.status === 401);
balanceReply = { status: 403, body: { error: { code: "open_key_route_not_allowed" } } };
const ko = await d.balance();
check("a model-API key (403 on balance) is checked on the jobs list instead and reported as key-only", ko.keyOnly === true && ko.usd === null, JSON.stringify(ko));
jobsListStatus = 401; threw = null; try { await d.balance(); } catch (e) { threw = e; }
check("…and a bad key still fails there", threw && threw.status === 401);
jobsListStatus = 200;
check("cancel before the provider starts: cancelled", (await d.cancelJob({ jobId: "job_1" })).cancelled === true && seen.cancels === 1);
cancelReply = 409;
const c2 = await d.cancelJob({ jobId: "job_1" });
check("cancel after it started (409): refused, with the reason", c2.cancelled === false && /already started/.test(c2.reason), JSON.stringify(c2));
cancelReply = 200;

console.log("\nthrough the job queue");
const DIR = "Show/E1";
await store.scaffold(DIR);
await fs.copyFile(img, path.join(ROOT, DIR, "03_storyboard", "a.png"));
const mkEp = () => store.saveEpisode(DIR, {
  name: "E1", dir: DIR, fmt: "9:16",
  shots: [{ id: "s1", sceneNum: "1", shotCode: "a", label: "turn", move: "static", action: "She turns.", beats: [{ id: "b1", keyframe: true, role: "start", frame: { path: `${DIR}/03_storyboard/a.png`, approved: true } }], versions: [], selectedVersions: [] }],
  ledger: { budgetCapUSD: 10, confirmAboveUSD: 5, spentUSD: 0, entries: [] },
});
await mkEp();
threw = null;
try { await jobs.submitFanOut(DIR, { shotIds: ["s1"], modelIds: [SD25], seconds: 5, driver: "fal", route: false }); } catch (e) { threw = e; }
check("refused while Sume isn't connected (nothing created)", threw && /sume" not ready/.test(threw.message) && !(await store.loadEpisode(DIR)).shots[0].versions.length, threw && threw.message);
jobs.drivers.sume.key = "sume-test-key-1234"; jobs.drivers.sume.base = BASE;
plan = ["processing", "completed"]; polls = 0;
const out = await jobs.submitFanOut(DIR, { shotIds: ["s1"], modelIds: [SD25], seconds: 5, driver: "fal" });
check("the take is queued on the sume driver at the Sume price", out.versions[0].driver === "sume" && Math.abs(out.versions[0].estimateUSD - 1.16) < 0.01, JSON.stringify(out.versions[0]));
let v = null;
for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 500)); v = (await store.loadEpisode(DIR)).shots[0].versions[0]; if (v.state === "done" || v.state === "error") break; }
check("it lands in takes/ and is charged at the estimate on driver sume", v.state === "done" && /05_delivery\/takes\//.test(v.path), JSON.stringify(v));
let led = (await store.loadEpisode(DIR)).ledger;
check("one ledger entry, driver sume", led.entries.length === 1 && led.entries[0].driver === "sume" && Math.abs(led.spentUSD - 1.16) < 0.01, JSON.stringify(led));

await mkEp();
plan = ["failed"]; polls = 0;
await jobs.submitFanOut(DIR, { shotIds: ["s1"], modelIds: [SD25], seconds: 5, driver: "fal" });
for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 500)); v = (await store.loadEpisode(DIR)).shots[0].versions[0]; if (v && (v.state === "done" || v.state === "error")) break; }
led = (await store.loadEpisode(DIR)).ledger;
check("a failed Sume job is an error take and is NOT charged (Sume refunds it)", v.state === "error" && /refund/i.test(v.error) && led.entries.length === 0 && led.spentUSD === 0, JSON.stringify([v.state, v.error, led]));

console.log("\ncheapest route");
const FAL = "bytedance/seedance-2.5/image-to-video", ATL = "atlas:bytedance/seedance-2.5/image-to-video";
check("Sume is a sibling of the fal and Atlas Seedance 2.5 720p rows", R.routeSiblings(FAL).map((m) => m.id).sort().join() === [FAL, ATL, SD25].sort().join());
check("all three connected: Sume ($0.2312) beats Atlas ($0.33) and fal ($0.466)", R.cheapestRoute(FAL, () => true).modelId === SD25);
check("Sume not connected: Atlas still wins over fal", R.cheapestRoute(FAL, (v) => v !== "sume").modelId === ATL);
R.setLivePrice(FAL, { usd: 0.15 });
check("a live fal promo below Sume moves it back to fal", R.cheapestRoute(SD25, () => true).modelId === FAL);
R.setLivePrice(FAL, null);
R.setLivePrice(SD25, { usd: 0.05 });
check("and a live Sume promo wins over everything", R.cheapestRoute(FAL, () => true).modelId === SD25 && R.effectiveVideoRate(R.videoModel(SD25)) === 0.05);
R.setLivePrice(SD25, null);
check("the opt-in H3 Max reference row never wins a route", !R.cheapestRoute("minimax/h3-max/reference-to-video", () => true).modelId.startsWith("sume:"));

console.log("\nprice watch (Sume's public list)");
const pw = await import("../server/pricewatch.js");
let asked = [];
const catalog = { data: { currency: "USD", models: [
  { id: "seedance-2.5", kind: "video", pricing: { options: [{ resolution: "480p", usd: "0.1028" }, { resolution: "720p", usd: "0.1500" }, { resolution: "1080p", usd: "0.5686" }] } },
  { id: "minimax-h3", kind: "video", pricing: { options: [{ resolution: "768p", usd: "0.0600" }, { resolution: "2K", usd: "0.1300" }] } },
] } };
const fakeFetch = async (url, opts = {}) => { asked.push([String(url), (opts.headers || {}).authorization || ""]); return { ok: true, status: 200, json: async () => catalog }; };
delete process.env.FAL_KEY;
process.env.SUME_API_KEY = "sume-test-key-1234";
const st = await pw.checkPrices({ fetchImpl: fakeFetch });
check("reads the public price list (no key sent with it)", asked.some(([u, a]) => /\/v1\/open\/catalog$/.test(u) && a === ""), JSON.stringify(asked));
check("a promo shows up: Seedance 2.5 720p $0.2312 → $0.15 is reported as a drop", st.changes.some((c) => c.id === SD25 && c.direction === "down" && c.to === 0.15), JSON.stringify(st.changes));
check("the live price replaces the table in quotes and routing", R.effectiveVideoRate(R.videoModel(SD25)) === 0.15 && R.cheapestRoute(FAL, () => true).modelId === SD25);
const ep2 = { shots: [{ id: "s1", sceneNum: 1, shotCode: "a", move: "static", beats: [{ id: "b1", frame: { path: "f.png", approved: true }, approved: true }], versions: [] }], assets: [], ledger: { budgetCapUSD: 50, confirmAboveUSD: 100, spentUSD: 0, entries: [] } };
const qs = jobs.quote(ep2, { shotIds: ["s1"], modelIds: [SD25], seconds: 5, route: false });
check("a quote on a live Sume price is not flagged as an estimate (Sume quotes exactly)", qs.lines[0].confidence === "exact" && qs.uncalibrated.length === 0 && Math.abs(qs.totalUSD - 0.75) < 0.011, JSON.stringify(qs.lines[0]));
check("a resolution the list lacks is reported as unknown, not guessed", st.unknown.some((u) => u.id === "sume:minimax-h3/image-to-video@4K"));
delete process.env.SUME_API_KEY;
asked = [];
await pw.checkPrices({ fetchImpl: fakeFetch });
check("not asked at all while Sume isn't connected", !asked.some(([u]) => /sume/.test(u)));
R.setLivePrice(SD25, null);

srv.close();
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
await fs.rm(clip, { force: true }).catch(() => {});
console.log(`\n${fail === 0 ? "✓" : "✗"} sume: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
