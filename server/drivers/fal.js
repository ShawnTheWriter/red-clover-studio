// fal.ai driver — video generation via the queue API.
//
// The flow this implements is the one proven on 2026-09-10 (Man in the Glass
// street beat, Arm B), not a generic image-to-video call:
//   1. downscale the keyframe to 768px wide — the model renders at 768P base
//      anyway and full-size files are too large to pass inline
//   2. upload to fal storage, get a CDN url
//   3. submit to the queue with a prompt that describes MOTION ONLY; identity
//      rides on the image, never on the words
//   4. poll, then download the result next to the episode's other media
//
// Text-to-video is deliberately NOT exposed. The same test proved a fixed seed
// does not hold identity across prompts — three visibly different women. Adding
// a t2v path here would make the failed method one click away from the proven
// one, so it isn't offered.

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BaseDriver } from "./base.js";
import { videoModel, upscaleModel } from "../rates.js";

const run = promisify(execFile);

// Upload content types by extension. Stills and video keyframes were the only
// uploads until lip sync; unknown extensions keep the old image/jpeg default.
const CONTENT_TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".webm": "video/webm",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg",
};

const QUEUE_BASE = "https://queue.fal.run";
const UPLOAD_INITIATE = "https://rest.alpha.fal.ai/storage/upload/initiate";

// Scale to <= maxSide on the long side; if the result is wider (or taller)
// than maxAspect:1, pad the short side up to 2.4:1 (a margin under the limit).
// Returns null when no padding is needed.
export function padPlan(w, h, maxSide = 1280, maxAspect = 2.5) {
  if (!(w > 0 && h > 0)) return null;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const sw = Math.round(w * k / 2) * 2, sh = Math.round(h * k / 2) * 2;
  if (sw / sh <= maxAspect && sh / sw <= maxAspect) return null;
  const target = Math.min(2.4, maxAspect);
  const even = (n) => Math.ceil(n / 2) * 2;
  return sw > sh ? { w: sw, h: sh, padW: sw, padH: even(sw / target) } : { w: sw, h: sh, padW: even(sh / target), padH: sh };
}

export class FalDriver extends BaseDriver {
  constructor(config = {}) {
    super("fal", config);
    this.key = config.key || process.env.FAL_KEY || "";
  }

  status() {
    if (!this.key) return { ready: false, reason: "FAL_KEY not set — add it to .env" };
    return { ready: true, reason: "" };
  }

  headers(extra = {}) {
    return { authorization: `Key ${this.key}`, "content-type": "application/json", ...extra };
  }

  // Downscale a keyframe for upload. sips ships with macOS, so no dependency.
  // Returns a path to a temp file the caller is responsible for leaving alone;
  // it lives in the OS temp dir, never in the project.
  async prepareKeyframe(absImagePath, width = 768) {
    const tmp = path.join(
      process.env.TMPDIR || "/tmp",
      `rcs_kf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`,
    );
    try {
      await run("sips", ["-s", "format", "jpeg", "-Z", String(width), absImagePath, "--out", tmp], { timeout: 30000 });
      return tmp;
    } catch {
      return absImagePath; // fall back to the original rather than failing the job
    }
  }

  async uploadFile(absPath) {
    const bytes = await fs.readFile(absPath);
    const contentType = CONTENT_TYPES[path.extname(absPath).toLowerCase()] || "image/jpeg";

    const initRes = await fetch(UPLOAD_INITIATE, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ content_type: contentType, file_name: path.basename(absPath) }),
    });
    if (!initRes.ok) throw new Error(`fal upload initiate failed: ${initRes.status} ${await initRes.text()}`);
    const { upload_url, file_url } = await initRes.json();

    const putRes = await fetch(upload_url, {
      method: "PUT",
      headers: { "content-type": contentType },
      body: bytes,
    });
    if (!putRes.ok) throw new Error(`fal upload PUT failed: ${putRes.status}`);
    return file_url;
  }

  // Submit an image-to-video job. Returns { jobId, statusUrl, responseUrl }.
  // Each model names its own start/end image fields differently (MiniMax and
  // Seedance use image_url/end_image_url; Kling and Wan use start_image_url/
  // end_image_url) — rates.js's imageParams is the single place that mapping
  // lives, checked against each model's live fal schema on 2026-09-25.
  async generateVideo({ imagePath, endImagePath, referencePaths, referenceVideoPaths, aspectRatio, prompt, seconds, modelId }) {
    if (!this.key) throw new Error("FAL_KEY not set");
    const vm = videoModel(modelId) || {};
    const videoPaths = vm.refVideo ? (referenceVideoPaths || []) : [];
    if (vm.inputMode === "frames+refs") return this.#generateFramesRefVideo({ imagePath, endImagePath, referencePaths: referencePaths || [], videoPaths, aspectRatio, prompt, seconds, modelId });
    if ((referencePaths && referencePaths.length) || videoPaths.length) return this.#generateReferenceVideo({ referencePaths: referencePaths || [], videoPaths, aspectRatio, prompt, seconds, modelId });
    const params = vm.imageParams || ["image_url", "end_image_url"];
    const prepared = await this.prepareKeyframe(imagePath);
    const imageUrl = await this.uploadFile(prepared);

    // fixedParams: per-row settings (H3 Max: resolution, prompt expansion
    // off so what's sent is what's shown). Some schemas want duration as a
    // number, most as a string.
    const body = {
      ...(vm.fixedParams || {}),
      prompt,
      [params[0]]: imageUrl,
      duration: vm.durationAsNumber ? Number(seconds) : String(seconds),
    };

    let endImageUrl = null;
    if (endImagePath && params.length > 1) {
      const preparedEnd = await this.prepareKeyframe(endImagePath);
      endImageUrl = await this.uploadFile(preparedEnd);
      body[params[params.length - 1]] = endImageUrl;
    }

    const endpoint = vm.endpoint || modelId;
    const res = await fetch(`${QUEUE_BASE}/${endpoint}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`fal submit failed: ${res.status} ${await res.text()}`);
    const out = await res.json();
    return {
      jobId: out.request_id,
      statusUrl: out.status_url || `${QUEUE_BASE}/${endpoint}/requests/${out.request_id}/status`,
      responseUrl: out.response_url || `${QUEUE_BASE}/${endpoint}/requests/${out.request_id}`,
      imageUrl,
      endImageUrl,
    };
  }

  // Submit a lip-sync job: an existing take + a recorded audio file. Same queue
  // API, same getJob/download afterwards. syncMode says what to do when the
  // audio and video lengths differ (sync.so's own vocabulary).
  async generateLipsync({ videoPath, audioPath, syncMode, modelId }) {
    if (!this.key) throw new Error("FAL_KEY not set");
    const videoUrl = await this.uploadFile(videoPath);
    const audioUrl = await this.uploadFile(audioPath);
    const res = await fetch(`${QUEUE_BASE}/${modelId}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ video_url: videoUrl, audio_url: audioUrl, sync_mode: syncMode || "cut_off" }),
    });
    if (!res.ok) throw new Error(`fal lip-sync submit failed: ${res.status} ${await res.text()}`);
    const out = await res.json();
    return {
      jobId: out.request_id,
      statusUrl: out.status_url || `${QUEUE_BASE}/${modelId}/requests/${out.request_id}/status`,
      responseUrl: out.response_url || `${QUEUE_BASE}/${modelId}/requests/${out.request_id}`,
    };
  }

  // Upscale a finished clip to `target` (1080p). The request body differs per
  // model, so it is built here from the rates.js row; the queue, polling and
  // download afterwards are the same as any other video job. `fps` is the
  // SOURCE frame rate: Bytedance is asked for it explicitly (its default is 30,
  // which would re-time a 24 fps take); SeedVR2 has no such field and is
  // corrected afterwards in jobs.js.
  async generateUpscale({ videoPath, modelId, target = "1080p", fps = 24 }) {
    if (!this.key) throw new Error("FAL_KEY not set");
    const m = upscaleModel(modelId);
    if (!m) throw new Error(`unknown upscale model "${modelId}"`);
    const videoUrl = await this.uploadFile(videoPath);
    let input;
    if (modelId.includes("seedvr")) {
      input = { video_url: videoUrl, upscale_mode: "target", target_resolution: target, output_quality: "high" };
    } else if (modelId.includes("bytedance-upscaler")) {
      input = {
        video_url: videoUrl, target_resolution: target, target_fps: Math.min(120, Math.max(24, Math.round(Number(fps) || 24))),
        enhancement_preset: "aigc", enhancement_tier: "standard", fidelity: "high",
      };
    } else {
      throw new Error(`no request mapping for upscale model "${modelId}"`);
    }
    const res = await fetch(`${QUEUE_BASE}/${modelId}`, { method: "POST", headers: this.headers(), body: JSON.stringify(input) });
    if (!res.ok) throw new Error(`fal upscale submit failed: ${res.status} ${await res.text()}`);
    const out = await res.json();
    return {
      jobId: out.request_id,
      statusUrl: out.status_url || `${QUEUE_BASE}/${modelId}/requests/${out.request_id}/status`,
      responseUrl: out.response_url || `${QUEUE_BASE}/${modelId}/requests/${out.request_id}`,
    };
  }

  // Reference-to-video (Seedance omni-reference): many images addressed in the
  // prompt as @Image1…, instead of a start/end pair. References are downscaled
  // to 1280 on the long side (more detail than a 768 keyframe, still far under
  // the 30 MB limit). Resolution is sent explicitly so the price ceiling in
  // rates.js — computed at 720p — is what actually gets billed.
  async #generateReferenceVideo({ referencePaths, videoPaths = [], aspectRatio, prompt, seconds, modelId }) {
    // A model row may be a preset of another endpoint (the 480p draft): the
    // real fal path is `endpoint`, extra request fields are `fixedParams`.
    const model = videoModel(modelId) || {};
    const endpoint = model.endpoint || modelId;
    const imageUrls = [];
    for (const p of referencePaths) imageUrls.push(await this.uploadFile(await this.prepareKeyframe(p, 1280)));
    // Reference videos (motion only) as uploaded, addressed as @Video1….
    const videoUrls = [];
    for (const p of videoPaths) videoUrls.push(await this.uploadFile(p));
    const body = {
      prompt,
      ...(model.noTask ? {} : { task: "reference" }), // Seedance 2.0 has no task field
      image_urls: imageUrls,
      ...(videoUrls.length ? { [model.refVideo.param]: videoUrls } : {}),
      duration: String(seconds),
      resolution: "720p",
      aspect_ratio: aspectRatio === "16:9" ? "16:9" : "9:16",
      ...(model.fixedParams || {}),
    };
    const res = await fetch(`${QUEUE_BASE}/${endpoint}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`fal submit failed: ${res.status} ${await res.text()}`);
    const out = await res.json();
    return {
      jobId: out.request_id,
      statusUrl: out.status_url || `${QUEUE_BASE}/${endpoint}/requests/${out.request_id}/status`,
      responseUrl: out.response_url || `${QUEUE_BASE}/${endpoint}/requests/${out.request_id}`,
      imageUrls,
    };
  }

  // H3 Max references: start/end frames as image_url/end_image_url, the
  // Identity Vault images as reference_image_urls ("Image 1…" in the prompt).
  // The endpoint refuses images wider or taller than 2.5:1 (Overlock's face
  // sheet is 2048x768), so prepareReference pads them with black, never crops.
  async #generateFramesRefVideo({ imagePath, endImagePath, referencePaths, videoPaths = [], aspectRatio, prompt, seconds, modelId }) {
    const vm = videoModel(modelId) || {};
    const endpoint = vm.endpoint || modelId;
    const imageUrl = await this.uploadFile(await this.prepareKeyframe(imagePath));
    const endImageUrl = endImagePath ? await this.uploadFile(await this.prepareKeyframe(endImagePath)) : null;
    const refUrls = [];
    for (const p of referencePaths) refUrls.push(await this.uploadFile(await this.prepareReference(p, 1280, vm.maxRefAspect || 2.5)));
    const videoUrls = [];
    for (const p of videoPaths) videoUrls.push(await this.uploadFile(p));
    const body = {
      ...(vm.fixedParams || {}),
      prompt,
      image_url: imageUrl,
      ...(endImageUrl ? { end_image_url: endImageUrl } : {}),
      ...(refUrls.length ? { reference_image_urls: refUrls } : {}),
      ...(videoUrls.length ? { [vm.refVideo.param]: videoUrls } : {}),
      duration: Number(seconds),
      aspect_ratio: aspectRatio === "16:9" ? "16:9" : "9:16",
    };
    const res = await fetch(`${QUEUE_BASE}/${endpoint}`, { method: "POST", headers: this.headers(), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`fal submit failed: ${res.status} ${await res.text()}`);
    const out = await res.json();
    return {
      jobId: out.request_id,
      statusUrl: out.status_url || `${QUEUE_BASE}/${endpoint}/requests/${out.request_id}/status`,
      responseUrl: out.response_url || `${QUEUE_BASE}/${endpoint}/requests/${out.request_id}`,
      imageUrl, endImageUrl, refUrls,
    };
  }

  // A reference image at <= maxSide px, padded with black to fit within
  // maxAspect:1 either way. Falls back to the plain keyframe prep.
  async prepareReference(absImagePath, maxSide = 1280, maxAspect = 2.5) {
    try {
      const info = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", absImagePath], { timeout: 20000 });
      const txt = String(info.stdout || info);
      const w = Number((txt.match(/pixelWidth:\s*(\d+)/) || [])[1]);
      const h = Number((txt.match(/pixelHeight:\s*(\d+)/) || [])[1]);
      const plan = padPlan(w, h, maxSide, maxAspect);
      if (!plan) return this.prepareKeyframe(absImagePath, maxSide);
      const tmp = path.join(process.env.TMPDIR || "/tmp", `rcs_ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`);
      await run("ffmpeg", ["-v", "error", "-y", "-i", absImagePath, "-vf", `scale=${plan.w}:${plan.h},pad=${plan.padW}:${plan.padH}:(ow-iw)/2:(oh-ih)/2:color=black`, "-q:v", "3", tmp], { timeout: 30000 });
      return tmp;
    } catch {
      return this.prepareKeyframe(absImagePath, maxSide);
    }
  }

  async getJob({ jobId, modelId, statusUrl, responseUrl }) {
    const path_ = (videoModel(modelId) || {}).endpoint || modelId;
    const sUrl = statusUrl || `${QUEUE_BASE}/${path_}/requests/${jobId}/status`;
    const res = await fetch(sUrl, { headers: this.headers() });
    if (!res.ok) return { state: "error", error: `status ${res.status}: ${await res.text()}` };
    const s = await res.json();

    // fal's queue status endpoint documents exactly three values — IN_QUEUE,
    // IN_PROGRESS, COMPLETED (https://fal.ai/docs/.../queue#request-lifecycle).
    // A job failure surfaces as a non-2xx on this same fetch (handled above) or
    // as COMPLETED with no video in the result (handled below), never as a
    // fourth status string. So anything outside the three documented values —
    // a typo, a future status fal adds, a malformed response — is a REAL
    // anomaly, not "still running." Treating it as running let a provider-side
    // oddity burn the full 20-minute timeout in a concurrency slot instead of
    // surfacing immediately.
    const status = (s.status || "").toUpperCase();
    if (status === "IN_QUEUE") return { state: "queued", position: s.queue_position ?? null };
    if (status === "IN_PROGRESS") return { state: "running" };
    if (status !== "COMPLETED") return { state: "error", error: `unexpected queue status ${JSON.stringify(s.status)}`, raw: s };

    const rUrl = responseUrl || `${QUEUE_BASE}/${path_}/requests/${jobId}`;
    const rres = await fetch(rUrl, { headers: this.headers() });
    if (!rres.ok) return { state: "error", error: `result ${rres.status}: ${await rres.text()}` };
    const result = await rres.json();

    const videoUrl = result?.video?.url || result?.videos?.[0]?.url || null;
    if (!videoUrl) return { state: "error", error: "completed but no video url in response", raw: result };

    // fal sometimes reports billable units on the response; capture it when
    // present so the ledger can record an ACTUAL instead of only an estimate.
    const actualUSD = typeof result?.billing?.total_usd === "number" ? result.billing.total_usd : null;
    return { state: "done", result: { videoUrl, actualUSD, raw: result } };
  }

  async download(url, destAbs) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // A short read must fail loudly. Writing it straight to the take path left
    // a corrupt file marked "done" and charged for.
    const expected = Number(res.headers.get("content-length"));
    if (Number.isFinite(expected) && expected > 0 && buf.length !== expected) {
      throw new Error(`download truncated: got ${buf.length} bytes, expected ${expected}`);
    }
    await fs.mkdir(path.dirname(destAbs), { recursive: true });
    // Write beside the target and rename, so a failure mid-write never leaves a
    // half-file sitting at the path the timeline will probe.
    const tmp = `${destAbs}.part`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, destAbs);
    return destAbs;
  }

  // ---------- still images (GPT Image, Seedream — same queue API as video) ----------
  //
  // Image generation here finishes in seconds to under a minute (gpt-image-1
  // edit runs ~38s p50 / ~58s p90 per fal's own evidence), so unlike video this
  // blocks and returns once done — no job id, no reattach-after-restart
  // machinery needed. That keeps the shape identical to GeminiDriver's
  // generateImage/editImage, so jobs.js never has to know which service it's
  // actually talking to.
  //
  // fal doesn't share one image_size vocabulary across model families, so the
  // vertical/horizontal mapping is looked up per family here rather than
  // pushed up into jobs.js.
  #imageSizeFor(endpoint, fmt) {
    const vertical = fmt !== "16:9";
    if (endpoint.includes("gpt-image")) return vertical ? "1024x1536" : "1536x1024";
    if (endpoint.includes("seedream")) return vertical ? "portrait_16_9" : "landscape_16_9";
    return undefined;
  }

  async #submitImage(endpoint, input) {
    const res = await fetch(`${QUEUE_BASE}/${endpoint}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`fal image submit failed: ${res.status} ${await res.text()}`);
    const out = await res.json();
    return {
      statusUrl: out.status_url || `${QUEUE_BASE}/${endpoint}/requests/${out.request_id}/status`,
      responseUrl: out.response_url || `${QUEUE_BASE}/${endpoint}/requests/${out.request_id}`,
    };
  }

  async #pollImage(sub, { timeoutMs = 180000, intervalMs = 2000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`fal image generation timed out after ${Math.round(timeoutMs / 1000)}s`);
      const res = await fetch(sub.statusUrl, { headers: this.headers() });
      if (!res.ok) throw new Error(`fal image status failed: ${res.status} ${await res.text()}`);
      const s = await res.json();
      const status = (s.status || "").toUpperCase();
      if (status === "IN_QUEUE" || status === "IN_PROGRESS") { await new Promise((r) => setTimeout(r, intervalMs)); continue; }
      if (status !== "COMPLETED") throw new Error(`fal image: unexpected status ${JSON.stringify(s.status)}`);
      const rres = await fetch(sub.responseUrl, { headers: this.headers() });
      if (!rres.ok) throw new Error(`fal image result failed: ${rres.status} ${await rres.text()}`);
      return rres.json();
    }
  }

  // Run any queued fal model and wait for its JSON result (SFX from picture:
  // seconds to ~1 min). Returns { result, requestId }.
  async runQueued(endpoint, input, { timeoutMs = 300000 } = {}) {
    if (!this.key) throw new Error("FAL_KEY not set");
    const sub = await this.#submitImage(endpoint, input);
    const result = await this.#pollImage(sub, { timeoutMs, intervalMs: 3000 });
    return { result, requestId: (sub.responseUrl.match(/requests\/([^/?]+)/) || [])[1] || null };
  }

  // `endpoint` is the literal fal path — rates.js's IMAGE_MODELS[].endpoints.generate.
  async generateImage({ prompt, outPath, endpoint, fmt }) {
    if (!this.key) throw new Error("FAL_KEY not set");
    if (!endpoint) throw new Error("fal generateImage needs an endpoint — check rates.js IMAGE_MODELS");
    const input = { prompt };
    const size = this.#imageSizeFor(endpoint, fmt);
    if (size) input.image_size = size;
    const sub = await this.#submitImage(endpoint, input);
    const result = await this.#pollImage(sub);
    const url = result?.images?.[0]?.url;
    if (!url) throw new Error(`fal image: completed but no image url in response — ${JSON.stringify(result).slice(0, 300)}`);
    await this.download(url, outPath);
    return { path: outPath, meta: { model: endpoint } };
  }

  // `endpoint` is rates.js's IMAGE_MODELS[].endpoints.edit. `referenceImages`
  // are absolute local paths — uploaded to fal storage first, same as a video
  // keyframe.
  async editImage({ prompt, referenceImages = [], outPath, endpoint, fmt }) {
    if (!this.key) throw new Error("FAL_KEY not set");
    if (!endpoint) throw new Error("fal editImage needs an endpoint — check rates.js IMAGE_MODELS");
    const imageUrls = [];
    for (const ref of referenceImages) imageUrls.push(await this.uploadFile(ref));
    const input = { prompt, image_urls: imageUrls };
    const size = this.#imageSizeFor(endpoint, fmt);
    if (size) input.image_size = size;
    const sub = await this.#submitImage(endpoint, input);
    const result = await this.#pollImage(sub);
    const url = result?.images?.[0]?.url;
    if (!url) throw new Error(`fal image: completed but no image url in response — ${JSON.stringify(result).slice(0, 300)}`);
    await this.download(url, outPath);
    return { path: outPath, meta: { model: endpoint } };
  }
}
