// Upscale models sold by more than one service: the same Bytedance upscaler on fal and
// Atlas, Atlas's own upscaler, Topaz on Sume. Request bodies, prices (5 s minimum,
// frame-rate tiers), and the model row choosing the service. Fake fetch, no spend.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      ${detail}`}`); };
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-uproutes-"));
process.env.RCS_PROJECT_ROOT = ROOT;
process.env.RCS_PRICES_FILE = path.join(ROOT, "prices.json");
const R = await import("../server/rates.js");
const jobs = await import("../server/jobs.js");
const { AtlasDriver } = await import("../server/drivers/atlas.js");
const { SumeDriver } = await import("../server/drivers/sume.js");

console.log("rows");
const BD_FAL = "fal-ai/bytedance-upscaler/upscale/video", BD_ATL = "atlas:byteplus/video/upscaler", ATL = "atlas:atlascloud/video-upscaler", TOP = "sume:topaz-video", SEED = "fal-ai/seedvr/upscale/video";
check("every upscale row names its family, service and driver", R.UPSCALE_MODELS.every((m) => m.family && m.via && m.driver === m.via));
check("Bytedance is sold by fal and Atlas; SeedVR2 only by fal", R.UPSCALE_MODELS.filter((m) => m.family === "bdup").map((m) => m.via).sort().join() === "atlas,fal" && R.UPSCALE_MODELS.filter((m) => m.family === "seedvr").length === 1);
const near = (a, b) => Math.abs(a - b) < 1e-9;
check("11 s: fal Bytedance $0.0792, Atlas Bytedance $0.0759, Topaz $0.44", near(R.estimateUpscaleUSD(BD_FAL, { seconds: 11 }).usd, 0.0792) && near(R.estimateUpscaleUSD(BD_ATL, { seconds: 11 }).usd, 0.0759) && near(R.estimateUpscaleUSD(TOP, { seconds: 11 }).usd, 0.44));
check("Atlas's own upscaler bills a 5 s minimum ($0.09 for 3 s) then $0.018/s", near(R.estimateUpscaleUSD(ATL, { seconds: 3 }).usd, 0.09) && near(R.estimateUpscaleUSD(ATL, { seconds: 10 }).usd, 0.18));

console.log("\nrequest bodies");
const seen = [];
const fake = (out) => async (url, opts = {}) => { seen.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null }); return { ok: true, status: 200, json: async () => out, text: async () => "" }; };
const atlas = new AtlasDriver({ key: "k-test-1234", fetch: fake({ data: { id: "p1" } }), base: "https://atlas.test/api/v1" });
atlas.uploadFile = async () => "https://files.test/v.mp4";
let r = await atlas.generateUpscale({ videoPath: "x.mp4", modelId: BD_ATL, target: "1080p", fps: 24 });
let b = seen.at(-1).body;
check("Atlas Bytedance: model, video_url, standard/aigc, 1080p, fps = the take's (billing tier)", b.model === "byteplus/video/upscaler" && b.video_url && b.tool_version === "standard" && b.scene === "aigc" && b.resolution === "1080p" && b.fps === 24 && r.jobId === "p1", JSON.stringify(b));
await atlas.generateUpscale({ videoPath: "x.mp4", modelId: BD_ATL, fps: 60 });
check("a 60 fps source is capped at 30 so it bills the cheap tier", seen.at(-1).body.fps === 30);
await atlas.generateUpscale({ videoPath: "x.mp4", modelId: ATL, target: "1080p" });
b = seen.at(-1).body;
check("Atlas upscaler: model, `video` field (not video_url), target_resolution", b.model === "atlascloud/video-upscaler" && b.video === "https://files.test/v.mp4" && b.target_resolution === "1080p" && !("video_url" in b), JSON.stringify(b));
const sume = new SumeDriver({ key: "k-test-1234", fetch: fake({ data: { job: { id: "j1" }, status_url: "s", result_url: "r" } }), base: "https://sume.test" });
sume.uploadFile = async () => "https://media.test/v.mp4";
r = await sume.generateUpscale({ videoPath: "x.mp4", modelId: TOP, target: "1080p", fps: 24, seconds: 4.2, sourceShort: 480 });
b = seen.at(-1).body;
check("Sume Topaz: model, video_url, 1080p, whole-second duration, factor from the source, fps sent", b.model === "topaz-video" && b.video_url && b.resolution === "1080p" && b.duration === 5 && b.upscale.factor === 3 && b.upscale.fps === 24 && b.mode === "async" && r.jobId === "j1", JSON.stringify(b));

console.log("\nthe row chooses the service");
const ep = { shots: [{ id: "s1", sceneNum: 1, shotCode: "a", versions: [{ id: "T1", state: "done", path: "t.mp4", seconds: 5, modelLabel: "Seedance take", driver: "atlas", fps: 24 }], selectedVersions: [] }], assets: [], ledger: { budgetCapUSD: 50, confirmAboveUSD: 100, spentUSD: 0, entries: [] } };
const q = jobs.quoteUpscale(ep, { versionId: "T1", modelId: ATL, useTrim: false });
check("a quote on the Atlas upscaler prices the 5 s minimum", Math.abs(q.totalUSD - 0.09) < 0.011 && q.modelId === ATL, JSON.stringify(q));
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
console.log(`\n${fail === 0 ? "✓" : "✗"} upscale routes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
