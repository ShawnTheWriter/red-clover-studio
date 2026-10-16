// Comfy Router driver against a fake Comfy server: auth, request bodies for
// each model, status handling, result shapes, key check, and a full take
// through the job queue (cap, ledger, download). No real Comfy calls, no spend.

import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      ${detail}`}`); };

// ---- fake Comfy ----
const seen = { submits: [], paths: [], headers: [], polls: 0, stills: [] };
let stillReply = null; // override { status, body }
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
let statusPlan = ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"];
let resultKind = "h3"; // h3 -> task.content.url, sd -> content.video_url, failed -> task.status failed
let submitReply = null; // override { status, body }
const SRC = path.join(os.tmpdir(), `rcs-comfy-src-${process.pid}.mp4`);
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x568:rate=24:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", SRC]);
const VIDEO = await fs.readFile(SRC);
const srv = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  seen.headers.push(req.headers);
  const base = `http://127.0.0.1:${srv.address().port}`;
  if (req.url === "/out.mp4") { res.writeHead(200, { "content-type": "video/mp4", "content-length": VIDEO.length }); return res.end(VIDEO); }
  if (req.url.startsWith("/v2/models?")) return req.headers["x-api-key"] === "cmf-test-key-1234" ? json(200, { data: [], has_more: false }) : json(401, { message: "authentication required" });
  const sm = req.url.match(/^\/v2\/models\/(vertexai\/[^/]+)$/);
  if (sm && req.method === "POST") {
    seen.stills.push({ model: sm[1], body: JSON.parse(raw.toString()), key: req.headers["x-api-key"] });
    if (stillReply) return json(stillReply.status, stillReply.body);
    return json(200, { candidates: [{ content: { parts: [{ text: "ok" }, { inlineData: { mimeType: "image/png", data: PNG.toString("base64") } }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1290 } });
  }
  const m = req.url.match(/^\/v2\/models\/(.+?)\/requests(?:\/([^/]+?))?(\/status)?$/);
  if (!m) return json(404, { message: "Not Found" });
  seen.paths.push(`${req.method} ${req.url}`);
  if (req.method === "POST") {
    if (submitReply) return json(submitReply.status, submitReply.body);
    seen.submits.push({ model: m[1], body: JSON.parse(raw.toString()), idem: req.headers["idempotency-key"] });
    const id = `req_${seen.submits.length}`;
    return json(201, { request_id: id, status: "IN_QUEUE", status_url: `${base}/v2/models/${m[1]}/requests/${id}/status` });
  }
  if (m[3]) return json(200, { status: statusPlan[Math.min(seen.polls++, statusPlan.length - 1)] });
  if (resultKind === "sd") return json(200, { status: "succeeded", content: { video_url: `${base}/out.mp4` } });
  if (resultKind === "failed") return json(200, { task: { status: "failed", error: { message: "policy rejected" } } });
  if (resultKind === "none") return json(200, { task: { status: "succeeded", content: {} } });
  return json(200, { task: { status: "succeeded", content: { url: `${base}/out.mp4` }, usage: { output_seconds: 5 } } });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-comfy-"));
process.env.RCS_PROJECT_ROOT = ROOT;
process.env.RCS_COMFY_BASE_URL = BASE;
process.env.RCS_PRICES_FILE = path.join(ROOT, "prices.json"); // never the app's real price cache
delete process.env.COMFY_UI_API_KEY;
const store = await import("../server/store.js");
const jobs = await import("../server/jobs.js");
const { videoModel, VIDEO_MODELS, cheapestRoute } = await import("../server/rates.js");
const { ComfyDriver, findVideoUrl } = await import("../server/drivers/comfy.js");
// env.js loads the app's .env on import: never let a real key reach a test.
delete process.env.COMFY_UI_API_KEY; jobs.drivers.comfy.key = "";

const img = path.join(ROOT, "frame.png");
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=576x1024", "-frames:v", "1", img]);
const H3 = "comfy:minimax/minimax-h3";
const SD = "comfy:byteplus/dreamina-seedance-2-5-260628/image-to-video";
const SDREF = "comfy:byteplus/dreamina-seedance-2-5-260628/reference-to-video";

console.log("model rows");
check("Comfy rows exist and run on the comfy driver", [H3, SD, SDREF].every((id) => videoModel(id)?.driver === "comfy"));
check("H3 768P is $0.1287/s and its 2K row $0.1859/s", videoModel(H3).usdPerVideoSecond === 0.1287 && videoModel(`${H3}@2K`)?.usdPerVideoSecond === 0.1859 && videoModel(`${H3}@2K`).comfy.fixed.resolution === "2K");
check("Seedance 2.5 720p is ~$0.33/s from $0.0153 per 1k tokens", Math.abs(videoModel(SD).usdPerVideoSecond - 0.331) < 0.001);
check("fal and Atlas rows keep their drivers", VIDEO_MODELS.filter((m) => !m.id.startsWith("comfy:") && m.driver === "comfy").length === 0);
check("routing: a Comfy row goes to comfy, a fal row stays on fal, a rehearsal stays mock", jobs.driverForModel(H3, "fal") === "comfy" && jobs.driverForModel("minimax/h3/image-to-video", "fal") === "fal" && jobs.driverForModel(H3, "mock") === "mock");
const rt = cheapestRoute("minimax/h3/image-to-video@768P", () => true);
check("cheapest route never moves a fal pick onto Comfy (opt-in rows)", !rt.options.some((o) => o.id.startsWith("comfy:")) && rt.modelId.indexOf("comfy:") !== 0, JSON.stringify(rt.options));

console.log("\ndriver");
check("not ready without a key", !new ComfyDriver().status().ready);
const d = new ComfyDriver({ key: "cmf-test-key-1234" });
check("a good key passes the free catalog check", (await d.checkKey()) === true);
let threw = null; try { await new ComfyDriver({ key: "wrong-key-0000" }).checkKey(); } catch (e) { threw = e; }
check("a rejected key surfaces as 401", threw && threw.status === 401);

const sub = await d.generateVideo({ aspectRatio: "16:9", prompt: "a maple leaf", seconds: 5, modelId: H3 });
const t1 = seen.submits[0];
check("H3 text body: model path, one text item, 768P, 16:9, duration number", t1.model === "minimax/minimax-h3" && t1.body.content.length === 1 && t1.body.content[0].text === "a maple leaf" && t1.body.resolution === "768P" && t1.body.ratio === "16:9" && t1.body.duration === 5, JSON.stringify(t1.body));
check("X-API-Key and an Idempotency-Key uuid are sent", seen.headers[seen.headers.length - 1]["x-api-key"] === "cmf-test-key-1234" && /^[0-9a-f-]{36}$/.test(t1.idem));
check("returns the request id and status url", sub.jobId === "req_1" && /requests\/req_1\/status$/.test(sub.statusUrl) && /requests\/req_1$/.test(sub.responseUrl));

await d.generateVideo({ imagePath: img, endImagePath: img, aspectRatio: "9:16", prompt: "turn", seconds: 5, modelId: H3 });
const t2 = seen.submits[1].body;
check("H3 frames: first_frame data URI only (no last_frame), no ratio", t2.content.length === 2 && t2.content[1].role === "first_frame" && /^data:image\/(png|jpeg);base64,/.test(t2.content[1].image_url.url) && !t2.content.some((c) => c.role === "last_frame") && t2.ratio === undefined, JSON.stringify(t2).slice(0, 300));

await d.generateVideo({ imagePath: img, endImagePath: img, aspectRatio: "9:16", prompt: "turn", seconds: 6, modelId: SD });
const t3 = seen.submits[2];
check("Seedance frames: first_frame + last_frame, adaptive ratio, 720p, audio on", t3.model === "byteplus/dreamina-seedance-2-5-260628" && t3.body.content.map((c) => c.role).join() === ",first_frame,last_frame" && t3.body.ratio === "adaptive" && t3.body.resolution === "720p" && t3.body.generate_audio === true, JSON.stringify(t3.body).slice(0, 300));

await d.generateVideo({ referencePaths: [img, img], referenceVideoPaths: [SRC], aspectRatio: "9:16", prompt: "@Image1 walks", seconds: 5, modelId: SDREF });
const t4 = seen.submits[3].body;
check("Seedance refs: reference_image x2 + reference_video, ratio from the episode", t4.content.filter((c) => c.role === "reference_image").length === 2 && t4.content.filter((c) => c.role === "reference_video").length === 1 && t4.ratio === "9:16", JSON.stringify(t4).slice(0, 300));

statusPlan = ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"]; seen.polls = 0;
const jp = { jobId: sub.jobId, statusUrl: sub.statusUrl, responseUrl: sub.responseUrl };
const s1 = await d.getJob(jp), s2 = await d.getJob(jp), s3 = await d.getJob(jp);
check("IN_QUEUE → queued, IN_PROGRESS → running, COMPLETED → done with the url", s1.state === "queued" && s2.state === "running" && s3.state === "done" && /out\.mp4$/.test(s3.result.videoUrl), JSON.stringify([s1, s2, s3.state]));
check("no cost on the response, so actualUSD is null (charged at the estimate)", s3.result.actualUSD === null);
resultKind = "sd"; statusPlan = ["COMPLETED"]; seen.polls = 0;
const sd = await d.getJob(jp);
check("Seedance result shape (content.video_url) is read too", sd.state === "done" && /out\.mp4$/.test(sd.result.videoUrl));
resultKind = "failed";
const fl = await d.getJob(jp);
check("a failed task surfaces Comfy's reason", fl.state === "error" && /policy rejected/.test(fl.error), JSON.stringify(fl));
resultKind = "none";
const nu = await d.getJob(jp);
check("completed with no url is an error, not a silent success", nu.state === "error" && /no video url/.test(nu.error));
statusPlan = ["FAILED"]; seen.polls = 0;
const fs2 = await d.getJob(jp);
check("a FAILED status is an error", fs2.state === "error");
check("findVideoUrl handles both shapes and garbage", findVideoUrl({ task: { content: { url: "u" } } }) === "u" && findVideoUrl({ content: { video_url: "v" } }) === "v" && findVideoUrl({}) === null);
submitReply = { status: 402, body: { error_type: "insufficient_credits" } };
threw = null; try { await d.generateVideo({ aspectRatio: "9:16", prompt: "x", seconds: 5, modelId: H3 }); } catch (e) { threw = e; }
check("402 says to add credit", threw && /not enough credits/.test(threw.message));
submitReply = null;

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
try { await jobs.submitFanOut(DIR, { shotIds: ["s1"], modelIds: [H3], seconds: 5, driver: "fal" }); } catch (e) { threw = e; }
check("refused while Comfy isn't connected (nothing created)", threw && /comfy" not ready/.test(threw.message) && !(await store.loadEpisode(DIR)).shots[0].versions.length, threw && threw.message);
jobs.drivers.comfy.key = "cmf-test-key-1234";
jobs.drivers.comfy.base = BASE;
resultKind = "h3"; statusPlan = ["IN_PROGRESS", "COMPLETED"]; seen.polls = 0;
const out = await jobs.submitFanOut(DIR, { shotIds: ["s1"], modelIds: [H3], seconds: 5, driver: "fal" });
check("the take is queued on the comfy driver at the Comfy price", out.versions[0].driver === "comfy" && Math.abs(out.versions[0].estimateUSD - 0.64) < 0.01, JSON.stringify(out.versions[0]));
let v = null;
for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 500)); v = (await store.loadEpisode(DIR)).shots[0].versions[0]; if (v.state === "done" || v.state === "error") break; }
check("it lands: downloaded into takes/ with the model code in the name", v.state === "done" && /05_delivery\/takes\/1a_.*H3cmf_/.test(v.path), JSON.stringify(v));
const led = (await store.loadEpisode(DIR)).ledger;
check("charged at the estimate in the ledger, driver comfy", led.entries.length === 1 && led.entries[0].driver === "comfy" && Math.abs(led.spentUSD - 0.64) < 0.01, JSON.stringify(led));


console.log("\nstills (Nano Banana)");
const NB2 = "comfy:vertexai/gemini-3.1-flash-image", NBP = "comfy:vertexai/gemini-3-pro-image";
const { imageModel } = await import("../server/rates.js");
check("still rows exist, run on the comfy driver and carry the Router model path", [NB2, NBP].every((id) => imageModel(id)?.driver === "comfy" && /^vertexai\//.test(imageModel(id).endpoints.generate)));
check("the existing Gemini still row is untouched", imageModel("gemini-3.1-flash-image-preview")?.driver === "gemini");
const nbd = new ComfyDriver({ key: "cmf-test-key-1234", base: BASE });
const o1 = path.join(ROOT, "still1.png");
const g = await nbd.generateImage({ prompt: "a dusty workshop", outPath: o1, endpoint: imageModel(NB2).endpoints.generate, fmt: "9:16" });
const st1 = seen.stills[0];
check("generate: sync route, X-API-Key, Gemini-style body, image-only, 9:16", st1.model === "vertexai/gemini-3.1-flash-image" && st1.key === "cmf-test-key-1234" && st1.body.contents[0].parts[0].text === "a dusty workshop" && st1.body.generationConfig.responseModalities[0] === "IMAGE" && st1.body.generationConfig.imageConfig.aspectRatio === "9:16", JSON.stringify(st1.body));
check("the inline image is written to disk intact", (await fs.readFile(o1)).equals(PNG) && g.path === o1 && g.meta.usage.candidatesTokenCount === 1290);
const o2 = path.join(ROOT, "still2.png");
await nbd.editImage({ prompt: "HOLD: same face. She turns.", referenceImages: [img, img], outPath: o2, endpoint: imageModel(NBP).endpoints.edit, fmt: "3:7" });
const st2 = seen.stills[1];
check("edit: references go first as inlineData, the prompt last; an odd format sends no aspect ratio", st2.model === "vertexai/gemini-3-pro-image" && st2.body.contents[0].parts.length === 3 && st2.body.contents[0].parts[0].inlineData.data.length > 20 && st2.body.contents[0].parts[2].text.startsWith("HOLD") && !st2.body.generationConfig.imageConfig, JSON.stringify(st2.body).slice(0, 300));
stillReply = { status: 200, body: { candidates: [{ content: { parts: [{ text: "I can't make that image." }] } }] } };
threw = null; try { await nbd.generateImage({ prompt: "x", outPath: path.join(ROOT, "no.png"), endpoint: "vertexai/gemini-3.1-flash-image" }); } catch (e) { threw = e; }
check("a refusal with no image is an error carrying the model's words", threw && /no image: I can't make that image/.test(threw.message), threw && threw.message);
stillReply = { status: 402, body: { error_type: "insufficient_credits" } };
threw = null; try { await nbd.generateImage({ prompt: "x", outPath: path.join(ROOT, "no.png"), endpoint: "vertexai/gemini-3.1-flash-image" }); } catch (e) { threw = e; }
check("402 says to add credit", threw && /not enough credits/.test(threw.message));
stillReply = null;
threw = null; try { await new ComfyDriver({ key: "" }).generateImage({ prompt: "x", outPath: o1, endpoint: "vertexai/gemini-3.1-flash-image" }); } catch (e) { threw = e; }
check("no key, no call", threw && /COMFY_UI_API_KEY not set/.test(threw.message));

console.log("\na still through the board");
jobs.drivers.comfy.key = "cmf-test-key-1234"; jobs.drivers.comfy.base = BASE;
const DIR2 = "Show/E2";
await store.scaffold(DIR2);
await store.saveEpisode(DIR2, {
  name: "E2", dir: DIR2, fmt: "9:16",
  shots: [{ id: "s1", sceneNum: "1", shotCode: "a", label: "turn", move: "static", action: "She turns.", beats: [{ id: "b1", keyframe: true, role: "start", frame: null }], versions: [], selectedVersions: [] }],
  ledger: { budgetCapUSD: 10, confirmAboveUSD: 5, spentUSD: 0, entries: [] },
});
let still = null, stillErr = null;
try { still = await jobs.generateStill({ dir: DIR2, shotId: "s1", beatId: "b1", modelId: NB2 }); } catch (e) { stillErr = e; }
const led2 = (await store.loadEpisode(DIR2)).ledger;
check("the board makes a still on the comfy driver and books it at the row's price", !stillErr && led2.entries.length === 1 && led2.entries[0].driver === "comfy" && Math.abs(led2.spentUSD - 0.10) < 0.005, stillErr ? stillErr.message : JSON.stringify(led2));
check("the board's request used the episode's 9:16", seen.stills[seen.stills.length - 1].body.generationConfig.imageConfig?.aspectRatio === "9:16");

srv.close();
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
await fs.rm(SRC, { force: true }).catch(() => {});
console.log(`\n${fail === 0 ? "✓" : "✗"} comfy: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
