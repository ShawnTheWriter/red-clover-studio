// Comfy Router driver (Shawn, 2026-10-16: for the Open Source Higgsfield
// challenge, which requires the Comfy Developer Platform).
//
// The Router is Comfy's one API for partner models. Read from Comfy's docs and
// confirmed with one live MiniMax H3 text-to-video call on 2026-10-16:
//   POST {base}/v2/models/{provider}/{model}/requests   JSON -> 201 { request_id, status_url, ... }
//   GET  {base}/v2/models/{provider}/{model}/requests/{id}/status -> { status }
//        status: IN_QUEUE | IN_PROGRESS | COMPLETED (anything else terminal = failed/cancelled)
//   GET  {base}/v2/models/{provider}/{model}/requests/{id}        -> 200 result, 202 still running
//   GET  {base}/v2/models                                          -> catalog (free key check)
// Auth: "X-API-Key: <key>". An Idempotency-Key (uuid) is sent on submit.
// Body: { content: [{type:"text"},{type:"image_url", role, image_url:{url}}...], duration, resolution, ratio }.
// Images and videos go inline as data URIs (the Router has no upload step; the
// whole body is capped at 100 MiB). The result URL sits at task.content.url for
// MiniMax H3 and content.video_url for Seedance; both are searched.
//
// No cost comes back on the response (no X-Comfy-Credits-Used on H3), so takes
// are charged at the estimate in rates.js. The Router's published rate is
// 211 credits per US dollar; reconcile against the Comfy dashboard.
//
// Stills (Nano Banana through vertexai/gemini-3.1-flash-image) use the Router's
// synchronous route: POST {base}/v2/models/{provider}/{model} with a Gemini-style
// body ({contents, generationConfig}); the image comes back inline as
// candidates[].content.parts[].inlineData (or a 24 h fileData.fileUri).
//
// Only the H3 text and first-frame paths have been run against the real service. First/last
// frame, reference image and reference video bodies follow the model pages but
// are not yet proven live.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { BaseDriver } from "./base.js";
import { FalDriver } from "./fal.js";
import { videoModel } from "../rates.js";

export const COMFY_API = "https://api.comfy.org";

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime" };
const ASPECTS = new Set(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]);
const BODY_CAP = 100 * 1024 * 1024; // Router refuses bodies over 100 MiB

// Image prep (downscale, pad to the aspect limit) and download are the same
// local work as for fal; borrow them rather than copy them.
const local = new FalDriver({ key: "" });

async function dataUri(absPath) {
  const bytes = await fs.readFile(absPath);
  const type = MIME[path.extname(absPath).toLowerCase()] || "application/octet-stream";
  return `data:${type};base64,${bytes.toString("base64")}`;
}

// Find the video URL wherever this model keeps it.
export function findVideoUrl(body) {
  const t = (body && body.task) || body || {};
  const c = t.content || {};
  const url = c.video_url || c.url || (Array.isArray(t.outputs) ? t.outputs[0] : null);
  return typeof url === "string" && url ? url : null;
}

export class ComfyDriver extends BaseDriver {
  constructor(config = {}) {
    super("comfy", config);
    this.key = config.key || process.env.COMFY_UI_API_KEY || "";
    this.base = config.base || process.env.RCS_COMFY_BASE_URL || COMFY_API;
    this.fetch = config.fetch || ((...a) => fetch(...a));
  }

  status() {
    if (!this.key) return { ready: false, reason: "COMFY_UI_API_KEY not set — connect Comfy in Connections" };
    return { ready: true, reason: "" };
  }

  headers(extra = {}) {
    return { "x-api-key": this.key, ...extra };
  }

  // Free call: proves the key works. The catalog is paged; one page is enough.
  async checkKey() {
    const res = await this.fetch(`${this.base}/v2/models?limit=1`, { headers: this.headers() });
    if (!res.ok) throw Object.assign(new Error(`Comfy catalog ${res.status}`), { status: res.status });
    return true;
  }

  // ---- stills (Nano Banana) ----
  // Synchronous from the caller's side: the Router holds the connection (up to
  // 10 minutes) and returns the image. `endpoint` is the Router model path from
  // the row's `endpoints` in rates.js. Policy rejections are billed by the
  // vertexai models, so a refusal here has still cost something.
  async #still(parts, { endpoint, fmt, outPath }) {
    if (!this.key) throw new Error("COMFY_UI_API_KEY not set");
    if (!endpoint) throw new Error("Comfy still: no model path (set endpoints on the row in rates.js)");
    const generationConfig = { responseModalities: ["IMAGE"] };
    if (ASPECTS.has(fmt)) generationConfig.imageConfig = { aspectRatio: fmt };
    const res = await this.fetch(`${this.base}/v2/models/${endpoint}`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
    });
    if (res.status === 402) throw new Error("Comfy: not enough credits — add credit in your Comfy workspace and try again");
    if (!res.ok) throw new Error(`Comfy still failed: ${res.status} ${(await res.text()).slice(0, 400)}`);
    const out = await res.json();
    const cands = out.candidates || (out.response && out.response.candidates) || [];
    const got = [];
    for (const c of cands) for (const p of (c.content && c.content.parts) || []) got.push(p);
    const inline = got.map((p) => p.inlineData || p.inline_data).find((x) => x && x.data);
    const file = got.map((p) => p.fileData || p.file_data).find((x) => x && (x.fileUri || x.file_uri));
    let buf = null;
    if (inline) buf = Buffer.from(inline.data, "base64");
    else if (file) {
      const dl = await this.fetch(file.fileUri || file.file_uri);
      if (!dl.ok) throw new Error(`Comfy still download failed: ${dl.status}`);
      buf = Buffer.from(await dl.arrayBuffer());
    }
    if (!buf || !buf.length) {
      const text = got.map((p) => p.text).filter(Boolean).join(" ");
      throw new Error(`Comfy returned no image${text ? `: ${text.slice(0, 300)}` : ""}`);
    }
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, buf);
    return { path: outPath, meta: { model: endpoint, via: "comfy", usage: out.usageMetadata || null } };
  }

  async generateImage({ prompt, outPath, endpoint, fmt }) {
    return this.#still([{ text: prompt }], { endpoint, fmt, outPath });
  }

  // Same contract as the Gemini driver: references first, prompt last (the
  // caller puts the identity hold at the front of the prompt).
  async editImage({ prompt, referenceImages = [], outPath, endpoint, fmt }) {
    const parts = [];
    for (const ref of referenceImages) {
      const data = await fs.readFile(ref);
      parts.push({ inlineData: { mimeType: /\.png$/i.test(ref) ? "image/png" : /\.webp$/i.test(ref) ? "image/webp" : "image/jpeg", data: data.toString("base64") } });
    }
    parts.push({ text: prompt });
    return this.#still(parts, { endpoint, fmt, outPath });
  }

  async generateVideo({ imagePath, endImagePath, referencePaths, referenceVideoPaths, aspectRatio, prompt, seconds, modelId }) {
    if (!this.key) throw new Error("COMFY_UI_API_KEY not set");
    const vm = videoModel(modelId) || {};
    const c = vm.comfy;
    if (!c) throw new Error(`${modelId} has no Comfy settings in rates.js`);
    const content = [{ type: "text", text: prompt }];
    const fixed = { ...(c.fixed || {}) };
    if (vm.inputMode === "reference") {
      for (const p of referencePaths || []) {
        content.push({ type: "image_url", role: "reference_image", image_url: { url: await dataUri(await local.prepareReference(p, 1280, 2.5)) } });
      }
      for (const p of (vm.refVideo ? referenceVideoPaths || [] : [])) {
        content.push({ type: "video_url", role: "reference_video", video_url: { url: await dataUri(p) } });
      }
      if (!fixed.ratio) fixed.ratio = aspectRatio === "16:9" ? "16:9" : "9:16";
    } else if (imagePath) {
      content.push({ type: "image_url", role: "first_frame", image_url: { url: await dataUri(await local.prepareReference(imagePath, 1280, 2.5)) } });
      if (endImagePath && c.endFrame) {
        content.push({ type: "image_url", role: "last_frame", image_url: { url: await dataUri(await local.prepareReference(endImagePath, 1280, 2.5)) } });
      }
    } else {
      // Text only (the H3 path proven live): the ratio is required, never adaptive.
      fixed.ratio = aspectRatio === "16:9" ? "16:9" : "9:16";
    }
    const json = JSON.stringify({ content, duration: Number(seconds), ...fixed });
    if (Buffer.byteLength(json) > BODY_CAP) throw new Error("Comfy refused up front: the request body is over the Router's 100 MiB cap — send fewer or smaller references");
    const res = await this.fetch(`${this.base}/v2/models/${c.model}/requests`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
      body: json,
    });
    if (res.status === 402) throw new Error("Comfy: not enough credits — add credit in your Comfy workspace and try again");
    if (!res.ok) throw new Error(`Comfy submit failed: ${res.status} ${await res.text()}`);
    const out = await res.json();
    const id = out && out.request_id;
    if (!id) throw new Error(`Comfy submit returned no request_id: ${JSON.stringify(out).slice(0, 300)}`);
    const requestUrl = `${this.base}/v2/models/${c.model}/requests/${id}`;
    return { jobId: id, statusUrl: `${requestUrl}/status`, responseUrl: requestUrl };
  }

  async getJob({ jobId, statusUrl, responseUrl }) {
    const rUrl = responseUrl || (statusUrl ? statusUrl.replace(/\/status$/, "") : null);
    if (!statusUrl || !rUrl) return { state: "error", error: `Comfy: no status url for ${jobId}` };
    const sres = await this.fetch(statusUrl, { headers: this.headers() });
    if (!sres.ok) return { state: "error", error: `Comfy status ${sres.status}: ${await sres.text()}` };
    const sbody = await sres.json();
    const st = String(sbody.status || "").toUpperCase();
    if (st === "IN_QUEUE") return { state: "queued" };
    if (st === "IN_PROGRESS") return { state: "running" };
    if (st !== "COMPLETED") return { state: "error", error: `Comfy ${st.toLowerCase() || "unknown status"}: ${sbody.error || sbody.message || "no reason given"}`, raw: sbody };
    const rres = await this.fetch(rUrl, { headers: this.headers() });
    if (rres.status === 202) return { state: "running" };
    if (!rres.ok) return { state: "error", error: `Comfy result ${rres.status}: ${await rres.text()}` };
    const rbody = await rres.json();
    const t = rbody.task || rbody;
    const ts = String(t.status || "").toLowerCase();
    if (["failed", "cancelled", "canceled", "expired"].includes(ts)) {
      return { state: "error", error: `Comfy ${ts}: ${(t.error && (t.error.message || t.error)) || "no reason given"}`, raw: rbody };
    }
    const videoUrl = findVideoUrl(rbody);
    if (!videoUrl) return { state: "error", error: "Comfy: completed but no video url", raw: rbody };
    return { state: "done", result: { videoUrl, actualUSD: null, raw: rbody } };
  }

  download(url, destAbs) { return local.download(url, destAbs); }
}
