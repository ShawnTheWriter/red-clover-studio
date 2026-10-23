// Atlas Cloud driver (Shawn, 2026-10-12: the first provider after fal).
//
// Why: Atlas sells Seedance 2.5 at roughly two thirds of fal's price, and its
// Seedance pages advertise "Portrait Reference Support" — fal's Seedance
// reference mode rejected Shawn's realistic characters as "likenesses of real
// people". The first paid test answers whether faces get through here.
//
// API (Atlas's docs, read 2026-10-12):
//   POST https://api.atlascloud.ai/api/v1/model/uploadMedia   multipart "file" -> { url }
//   POST https://api.atlascloud.ai/api/v1/model/generateVideo  JSON { model, prompt, ... } -> { data: { id, status } }
//   GET  https://api.atlascloud.ai/api/v1/model/prediction/{id} -> { data: { status, outputs[], error } }
//   GET  https://api.atlascloud.ai/public/v1/balance          -> account balance (key check, free)
// Status values documented: processing, completed, failed (timeout in one
// example). Auth: "Authorization: Bearer <key>". Field names per model come
// from rates.js (`atlas` on the row): Seedance 2.5 i2v takes image/last_image,
// reference-to-video takes reference_images / reference_videos.
// No per-task cost comes back on the prediction, so takes are charged at the
// estimate; /public/v1/model-costs (daily buckets) is where to reconcile.

import { BaseDriver } from "./base.js";
import { FalDriver } from "./fal.js";
import { videoModel, finishModel } from "../rates.js";
import fs from "node:fs/promises";
import path from "node:path";

export const ATLAS_API = "https://api.atlascloud.ai/api/v1";
export const ATLAS_PUBLIC = "https://api.atlascloud.ai/public/v1";

const CONTENT_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime" };

// Image prep (downscale, pad to the 2.5:1 limit) and download are the same
// local work as for fal; borrow them rather than copy them.
const local = new FalDriver({ key: "" });

export class AtlasDriver extends BaseDriver {
  constructor(config = {}) {
    super("atlas", config);
    this.key = config.key || process.env.ATLAS_API_KEY || "";
    this.base = config.base || process.env.RCS_ATLAS_BASE_URL || ATLAS_API;
    this.publicBase = config.publicBase || process.env.RCS_ATLAS_PUBLIC_URL || ATLAS_PUBLIC;
    this.fetch = config.fetch || ((...a) => fetch(...a));
  }

  status() {
    if (!this.key) return { ready: false, reason: "ATLAS_API_KEY not set — connect Atlas Cloud in Connections" };
    return { ready: true, reason: "" };
  }

  headers(extra = {}) {
    return { authorization: `Bearer ${this.key}`, ...extra };
  }

  // Free call: proves the key works and says whether the account has money.
  async balance() {
    const res = await this.fetch(`${this.publicBase}/balance`, { headers: this.headers() });
    if (!res.ok) throw Object.assign(new Error(`Atlas balance ${res.status}`), { status: res.status });
    const body = await res.json();
    const d = body.data || body;
    const raw = d.balance ?? d.available ?? d.value ?? (d.balance && d.balance.value);
    const v = typeof raw === "object" && raw ? raw.value : raw;
    const usd = Number(v);
    return { usd: Number.isFinite(usd) ? usd : null, raw: body };
  }

  async uploadFile(absPath) {
    const bytes = await fs.readFile(absPath);
    const type = CONTENT_TYPES[path.extname(absPath).toLowerCase()] || "application/octet-stream";
    const form = new FormData();
    form.append("file", new Blob([bytes], { type }), path.basename(absPath));
    const res = await this.fetch(`${this.base}/model/uploadMedia`, { method: "POST", headers: this.headers(), body: form });
    if (!res.ok) throw new Error(`Atlas upload failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    const url = body.url || (body.data && (body.data.url || body.data.download_url));
    if (!url) throw new Error(`Atlas upload returned no url: ${JSON.stringify(body).slice(0, 200)}`);
    return url;
  }

  async generateVideo({ imagePath, endImagePath, referencePaths, referenceVideoPaths, aspectRatio, prompt, seconds, modelId, audio }) {
    if (!this.key) throw new Error("ATLAS_API_KEY not set");
    const vm = videoModel(modelId) || {};
    const a = vm.atlas;
    if (!a) throw new Error(`${modelId} has no Atlas settings in rates.js`);
    const body = { model: a.model, prompt, duration: Number(seconds), ...(a.fixed || {}) };
    // Sound off: the same price, no generated audio (Shawn heard a warble).
    if (audio === false && vm.audioSwitch) body.generate_audio = false;
    let uploaded = {};
    if (vm.inputMode === "reference") {
      const imgs = [];
      for (const p of referencePaths || []) imgs.push(await this.uploadFile(await local.prepareReference(p, 1280, 2.5)));
      const vids = [];
      for (const p of (vm.refVideo ? referenceVideoPaths || [] : [])) vids.push(await this.uploadFile(p));
      if (imgs.length) body[a.refImages || "reference_images"] = imgs;
      if (vids.length) body[a.refVideos || "reference_videos"] = vids;
      if (!body.ratio) body.ratio = aspectRatio === "16:9" ? "16:9" : "9:16";
      uploaded = { refUrls: imgs, videoUrls: vids };
    } else {
      const imageUrl = await this.uploadFile(await local.prepareReference(imagePath, 1280, 2.5));
      body[a.startField || "image"] = imageUrl;
      let endImageUrl = null;
      if (endImagePath && a.endField) {
        endImageUrl = await this.uploadFile(await local.prepareReference(endImagePath, 1280, 2.5));
        body[a.endField] = endImageUrl;
      }
      uploaded = { imageUrl, endImageUrl };
    }
    const res = await this.fetch(`${this.base}/model/generateVideo`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Atlas submit failed: ${res.status} ${await res.text()}`);
    const out = await res.json();
    const id = out && out.data && out.data.id;
    if (!id) throw new Error(`Atlas submit returned no prediction id: ${JSON.stringify(out).slice(0, 300)}`);
    return { jobId: id, statusUrl: `${this.base}/model/prediction/${id}`, responseUrl: null, ...uploaded };
  }

  // Upscale a finished clip (Atlas's own and BytePlus's video upscalers). The clip is
  // uploaded like any other input. fps is sent so BytePlus bills the 30 fps tier.
  async generateUpscale({ videoPath, modelId, target = "1080p", fps = 24 }) {
    if (!this.key) throw new Error("ATLAS_API_KEY not set");
    const videoUrl = await this.uploadFile(videoPath);
    let body;
    if (modelId.includes("byteplus/video/upscaler")) {
      body = { model: "byteplus/video/upscaler", video_url: videoUrl, tool_version: "standard", scene: "aigc", resolution: target, bitrate_level: "high", fps: Math.min(30, Math.max(15, Math.round(Number(fps) || 24))) };
    } else if (modelId.includes("atlascloud/video-upscaler")) {
      body = { model: "atlascloud/video-upscaler", video: videoUrl, target_resolution: target };
    } else {
      throw new Error(`no Atlas request mapping for upscale model "${modelId}"`);
    }
    const res = await this.fetch(`${this.base}/model/generateVideo`, { method: "POST", headers: this.headers({ "content-type": "application/json" }), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Atlas upscale failed: ${res.status} ${await res.text()}`);
    const out = await res.json();
    const id = out && out.data && out.data.id;
    if (!id) throw new Error(`Atlas upscale returned no prediction id: ${JSON.stringify(out).slice(0, 300)}`);
    return { jobId: id, statusUrl: `${this.base}/model/prediction/${id}`, responseUrl: null };
  }

  // Finish a draft at 1080p: only the draft's id is sent. Atlas's finish
  // inherits the draft's prompt, inputs, duration, ratio, seed and audio.
  async generateFinish({ draftId, modelId }) {
    if (!this.key) throw new Error("ATLAS_API_KEY not set");
    const m = finishModel(modelId);
    if (!m) throw new Error(`unknown finish model "${modelId}"`);
    if (!draftId) throw new Error("no draft id to finish");
    const res = await this.fetch(`${this.base}/model/generateVideo`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ model: m.atlasModel, draft_id: draftId }),
    });
    if (!res.ok) throw new Error(`Atlas finish failed: ${res.status} ${await res.text()}`);
    const out = await res.json();
    const id = out && out.data && out.data.id;
    if (!id) throw new Error(`Atlas finish returned no prediction id: ${JSON.stringify(out).slice(0, 300)}`);
    return { jobId: id, statusUrl: `${this.base}/model/prediction/${id}`, responseUrl: null };
  }

  async getJob({ jobId, statusUrl }) {
    const res = await this.fetch(statusUrl || `${this.base}/model/prediction/${jobId}`, { headers: this.headers() });
    if (!res.ok) return { state: "error", error: `Atlas status ${res.status}: ${await res.text()}` };
    const body = await res.json();
    const d = body.data || {};
    const status = String(d.status || "").toLowerCase();
    if (status === "completed" || status === "succeeded") {
      const url = Array.isArray(d.outputs) ? d.outputs[0] : null;
      if (!url) return { state: "error", error: "Atlas: completed but no output url", raw: d };
      return { state: "done", result: { videoUrl: url, actualUSD: null, raw: d } };
    }
    if (status === "failed" || status === "timeout" || status === "canceled" || status === "cancelled") {
      return { state: "error", error: `Atlas ${status}: ${d.error || "no reason given"}`, raw: d };
    }
    if (["created", "pending", "queued", "starting"].includes(status)) return { state: "queued" };
    // "processing", or a status Atlas's docs don't list yet: still working.
    // The 20-minute ceiling in jobs.js stops a job that never finishes.
    return { state: "running" };
  }

  download(url, destAbs) { return local.download(url, destAbs); }
}
