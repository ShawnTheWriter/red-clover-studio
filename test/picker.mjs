// The model picker's rows (rates.js): every resolution / tier / service is a
// row with coordinates; old ids still exist; what fal is sent per row.
// Network stubbed: no fal calls, no spend.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      ${detail}`}`); };

process.env.RCS_PRICES_FILE = path.join(os.tmpdir(), `rcs-picker-prices-${process.pid}.json`);
const R = await import("../server/rates.js");
const { resolveReferencePrompt } = await import("../shared/prompts.js");
const { FalDriver } = await import("../server/drivers/fal.js");
const V = R.VIDEO_MODELS;
const m = (id) => R.videoModel(id);

console.log("rows");
check("ids are unique", new Set(V.map((x) => x.id)).size === V.length);
check("every row has a family and a mode", V.every((x) => x.family && ["frames", "refs"].includes(x.mode)), V.filter((x) => !x.family).map((x) => x.id).join());
const OLD = ["minimax/h3/image-to-video", "minimax/h3-max/image-to-video", "minimax/h3-max/reference-to-video", "fal-ai/kling-video/v3/standard/image-to-video", "bytedance/seedance-2.5/image-to-video", "bytedance/seedance-2.0/fast/image-to-video", "bytedance/seedance-2.5/reference-to-video", "bytedance/seedance-2.5/reference-to-video:draft480", "alibaba/wan-3.0/image-to-video"];
check("every id existing takes and defaults point at still exists", OLD.every((id) => m(id)));
const key = (x) => [x.family, x.mode, x.tier, x.res, x.via].join("|");
check("no two rows share the same coordinates", new Set(V.map(key)).size === V.length);
const resOf = (fam, mode, tier = null) => V.filter((x) => x.family === fam && x.mode === mode && (x.tier || null) === tier && x.via === "fal").map((x) => x.res).sort();
check("Seedance 2.5 frames: 480p / 720p / 1080p", resOf("sd25", "frames").join() === "1080p,480p,720p", resOf("sd25", "frames").join());
check("Seedance 2.0 Standard: 480p–4k; Fast and Mini: 480p / 720p", resOf("sd20", "frames", "standard").join() === "1080p,480p,4k,720p" && resOf("sd20", "frames", "fast").join() === "480p,720p" && resOf("sd20", "frames", "mini").join() === "480p,720p");
check("H3 Max frames and references: 480P / 768P / 1080P; H3: 480P / 768P / 2K / 4K", resOf("h3max", "frames").join() === "1080P,480P,768P" && resOf("h3max", "refs").join() === "1080P,480P,768P" && resOf("h3", "frames").join() === "2K,480P,4K,768P");
check("a variant sends its resolution to the same fal endpoint", m("bytedance/seedance-2.5/image-to-video@1080p").endpoint === "bytedance/seedance-2.5/image-to-video" && m("bytedance/seedance-2.5/image-to-video@1080p").fixedParams.resolution === "1080p");
check("H3 Max keeps its fixed settings at other resolutions", m("minimax/h3-max/image-to-video@480P").fixedParams.prompt_expansion_mode === "balanced" && m("minimax/h3-max/image-to-video@480P").fixedParams.resolution === "480P");
const rate768 = m("minimax/h3-max/image-to-video").usdPerVideoSecond;
check("H3 Max prices scale 1.0 / 1.6 / 3.2 from the same billed-second rate", Math.abs(m("minimax/h3-max/image-to-video@1080P").usdPerVideoSecond - rate768 * 2) < 1e-9 && Math.abs(m("minimax/h3-max/image-to-video@480P").usdPerVideoSecond - rate768 / 1.6) < 1e-9);
check("Seedance 2.5 1080p ≈ 2.25× 720p (token formula)", Math.abs(m("bytedance/seedance-2.5/image-to-video@1080p").usdPerVideoSecond / 0.462 - 2.25) < 0.02);
check("Seedance 2.0 references: 9 images, 3 videos, no task field", m("bytedance/seedance-2.0/reference-to-video").maxRefs === 9 && m("bytedance/seedance-2.0/reference-to-video").refVideo.max === 3 && m("bytedance/seedance-2.0/reference-to-video").noTask);
check("Atlas rows keep their service and put the resolution in Atlas's fields", m("atlas:bytedance/seedance-2.5/image-to-video@1080p").driver === "atlas" && m("atlas:bytedance/seedance-2.5/image-to-video@1080p").atlas.fixed.resolution === "1080p" && !m("atlas:bytedance/seedance-2.5/image-to-video@1080p").fixedParams);
check("file-name codes are distinct", new Set(V.map((x) => x.short)).size === V.length);
check("labels read Model (tier) — mode (quality) · service", m("bytedance/seedance-2.0/mini/reference-to-video@480p").label === "Seedance 2.0 Mini — references (480p)" && m("atlas:bytedance/seedance-2.5/image-to-video@480p").label === "Seedance 2.5 (480p) · Atlas");
check("price watch converts a variant with its own factor", Math.abs(R.convertFalPrice("minimax/h3-max/image-to-video@1080P", "seconds", 0.05) - 0.16) < 1e-9 && Math.abs(R.convertFalPrice("bytedance/seedance-2.0/image-to-video@480p", "1000 tokens", 0.014) - 0.1345) < 0.001);

console.log("\nreference image limit per model");
const shot = { id: "s", beats: [], refs: [] };
const ep = { assets: [] };
for (let i = 0; i < 14; i++) { ep.assets.push({ id: `a${i}`, type: "prop", name: `P${i}`, path: `x/${i}.png` }); shot.refs.push(`a${i}`); }
check("9 for Seedance 2.0, 12 by default", resolveReferencePrompt(shot, ep, { max: 9 }).images.length === 9 && resolveReferencePrompt(shot, ep).images.length === 12);

console.log("\nwhat fal is sent");
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-picker-"));
const img = path.join(TMP, "f.png");
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=576x1024", "-frames:v", "1", img]);
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("storage/upload/initiate")) return { ok: true, json: async () => ({ upload_url: "https://up.test/x", file_url: "https://files.test/x.jpg" }) };
  if (u.startsWith("https://up.test")) return { ok: true };
  sent.push({ url: u, body: JSON.parse(opts.body || "{}") });
  return { ok: true, json: async () => ({ request_id: "req1" }) };
};
const fal = new FalDriver({ key: "test" });
await fal.generateVideo({ imagePath: img, endImagePath: img, aspectRatio: "9:16", prompt: "p", seconds: 6, modelId: "minimax/h3-max/image-to-video@1080P" });
check("H3 Max 1080P → h3-max endpoint, resolution 1080P", sent[0].url.endsWith("/minimax/h3-max/image-to-video") && sent[0].body.resolution === "1080P" && sent[0].body.prompt_expansion_mode === "balanced", JSON.stringify(sent[0]));
await fal.generateVideo({ referencePaths: [img], aspectRatio: "9:16", prompt: "@Image1", seconds: 5, modelId: "bytedance/seedance-2.0/mini/reference-to-video@480p" });
check("Seedance 2.0 Mini refs 480p → mini endpoint, 480p, no task", sent[1].url.endsWith("/bytedance/seedance-2.0/mini/reference-to-video") && sent[1].body.resolution === "480p" && !("task" in sent[1].body), JSON.stringify(sent[1]));
await fal.generateVideo({ referencePaths: [img], aspectRatio: "9:16", prompt: "@Image1", seconds: 5, modelId: "bytedance/seedance-2.5/reference-to-video@1080p" });
check("Seedance 2.5 refs 1080p keeps task: reference", sent[2].body.task === "reference" && sent[2].body.resolution === "1080p");
await fal.generateVideo({ imagePath: img, aspectRatio: "9:16", prompt: "p", seconds: 5, modelId: "minimax/h3/image-to-video" });
check("plain H3 still runs at fal's default (2K): no resolution sent", sent[3].url.endsWith("/minimax/h3/image-to-video") && !("resolution" in sent[3].body));
globalThis.fetch = realFetch;
await fs.rm(TMP, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "✓" : "✗"} picker: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
