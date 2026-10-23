// Sume driver (Shawn, 2026-10-23: wholesale video at the provider's price, 0% markup).
//
// API (Sume's docs and OpenAPI schema, read 2026-10-23; not yet run against a key):
//   POST {base}/v1/files/generate-upload-url  { content_type, size_bytes, filename }
//        -> 201 { data: { upload_url, upload_headers, public_url } }   then PUT the bytes (no API key)
//   POST {base}/v1/video-router/generate      { model, prompt, image_url, end_image_url,
//        reference_image_urls, reference_video_urls, resolution, duration, aspect_ratio,
//        generate_audio, mode:"async" } + Idempotency-Key header
//        -> 202 { data: { job: { id }, status_url, result_url, cancel_url, cancelable } }
//   GET  {base}/v1/jobs/{id}/status  -> { data: { sume_status: queued|processing|completed|failed|canceled } }
//   GET  {base}/v1/jobs/{id}/result  -> { data: { result: { artifacts: [{ url, type, content_type }] } } }
//   GET  {base}/v1/jobs/{id}         -> job envelope (job.error on a failure)
//   POST {base}/v1/jobs/{id}/cancel  -> 200, or 409 job_generation_already_started
//   GET  {base}/v1/balance           -> { data: { balance: { available_usd } } }  (free key check)
//   GET  {base}/v1/open/catalog      -> PUBLIC, no key: every model's USD price per second
// Input media must be public HTTPS URLs, so local images and clips are uploaded
// first (uploading is free). Auth: "Authorization: Bearer <key>". A failed or
// cancelled job is refunded in full, so those never reach the ledger
// (`noCharge`). The price is held at submit and captured on completion; no
// per-take figure comes back, so a finished take is charged at the estimate.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { BaseDriver } from "./base.js";
import { FalDriver } from "./fal.js";
import { videoModel } from "../rates.js";

export const SUME_API = "https://api.sume.com";

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime" };

// Image prep (downscale, pad to the aspect limit) and download are the same
// local work as for fal; borrow them rather than copy them.
const local = new FalDriver({ key: "" });

export class SumeDriver extends BaseDriver {
  constructor(config = {}) {
    super("sume", config);
    this.key = config.key || process.env.SUME_API_KEY || "";
    this.base = config.base || process.env.RCS_SUME_BASE_URL || SUME_API;
    this.fetch = config.fetch || ((...a) => fetch(...a));
  }

  status() {
    if (!this.key) return { ready: false, reason: "SUME_API_KEY not set — connect Sume in Connections" };
    return { ready: true, reason: "" };
  }

  headers(extra = {}) {
    return { authorization: `Bearer ${this.key}`, ...extra };
  }

  // Free call: proves the key works and says what the account holds.
  async balance() {
    const res = await this.fetch(`${this.base}/v1/balance`, { headers: this.headers() });
    // A model-API key (the kind the dashboard hands out) is refused on account routes
    // (403 open_key_route_not_allowed) but still proves itself on the jobs list.
    if (res.status === 403) {
      const j = await this.fetch(`${this.base}/v1/jobs?limit=1`, { headers: this.headers() });
      if (!j.ok) throw Object.assign(new Error(`Sume key check ${j.status}`), { status: j.status });
      return { usd: null, invoiced: false, keyOnly: true, raw: null };
    }
    if (!res.ok) throw Object.assign(new Error(`Sume balance ${res.status}`), { status: res.status });
    const b = ((await res.json()).data || {}).balance || {};
    const usd = Number(b.available_usd);
    return { usd: Number.isFinite(usd) ? usd : null, invoiced: !!b.invoice, raw: b };
  }

  async uploadFile(absPath) {
    const bytes = await fs.readFile(absPath);
    const type = MIME[path.extname(absPath).toLowerCase()] || "application/octet-stream";
    const res = await this.fetch(`${this.base}/v1/files/generate-upload-url`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ content_type: type, size_bytes: bytes.length, filename: path.basename(absPath) }),
    });
    if (!res.ok) throw new Error(`Sume upload failed: ${res.status} ${await res.text()}`);
    const d = (await res.json()).data || {};
    if (!d.upload_url || !d.public_url) throw new Error(`Sume upload returned no address: ${JSON.stringify(d).slice(0, 200)}`);
    // Presigned: no API key on this request, exactly the headers Sume names.
    const put = await this.fetch(d.upload_url, { method: d.upload_method || "PUT", headers: { "content-type": type, ...(d.upload_headers || {}) }, body: bytes });
    if (!put.ok) throw new Error(`Sume upload failed: ${put.status} ${await put.text()}`);
    return d.public_url;
  }

  async generateVideo({ imagePath, endImagePath, referencePaths, referenceVideoPaths, aspectRatio, prompt, seconds, modelId, audio }) {
    if (!this.key) throw new Error("SUME_API_KEY not set");
    const vm = videoModel(modelId) || {};
    const s = vm.sume;
    if (!s) throw new Error(`${modelId} has no Sume settings in rates.js`);
    const body = { model: s.model, prompt, duration: Number(seconds), mode: "async", ...(s.fixed || {}) };
    if (s.aspect) body.aspect_ratio = aspectRatio === "16:9" ? "16:9" : "9:16";
    // Sound off, only where Sume exposes the switch (the Seedance rows).
    if (audio === false && vm.audioSwitch) body.generate_audio = false;
    const uploaded = {};
    const refMode = vm.inputMode === "reference" || vm.inputMode === "frames+refs";
    if (vm.inputMode !== "reference") {
      uploaded.imageUrl = await this.uploadFile(await local.prepareReference(imagePath, 1280, 2.5));
      body.image_url = uploaded.imageUrl;
      if (endImagePath) {
        uploaded.endImageUrl = await this.uploadFile(await local.prepareReference(endImagePath, 1280, 2.5));
        body.end_image_url = uploaded.endImageUrl;
      }
    }
    if (refMode) {
      const imgs = [];
      for (const p of referencePaths || []) imgs.push(await this.uploadFile(await local.prepareReference(p, 1280, 2.5)));
      const vids = [];
      for (const p of (vm.refVideo ? referenceVideoPaths || [] : [])) vids.push(await this.uploadFile(p));
      if (imgs.length) body.reference_image_urls = imgs;
      if (vids.length) body.reference_video_urls = vids;
      uploaded.refUrls = imgs; uploaded.videoUrls = vids;
    }
    const res = await this.fetch(`${this.base}/v1/video-router/generate`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Sume submit failed: ${res.status} ${await res.text()}`);
    const d = (await res.json()).data || {};
    const id = d.job && d.job.id;
    if (!id) throw new Error(`Sume submit returned no job id: ${JSON.stringify(d).slice(0, 300)}`);
    return { jobId: id, statusUrl: d.status_url || `${this.base}/v1/jobs/${id}/status`, responseUrl: d.result_url || `${this.base}/v1/jobs/${id}/result`, ...uploaded };
  }

  // Sume cancels only before the provider has started (409 afterwards).
  async cancelJob({ jobId }) {
    const res = await this.fetch(`${this.base}/v1/jobs/${jobId}/cancel`, { method: "POST", headers: this.headers() });
    if (res.ok) return { cancelled: true };
    if (res.status === 409) return { cancelled: false, reason: "Sume had already started this one, so it will finish and bill" };
    return { cancelled: false, reason: `Sume said ${res.status}` };
  }

  async getJob({ jobId, statusUrl, responseUrl }) {
    const res = await this.fetch(statusUrl || `${this.base}/v1/jobs/${jobId}/status`, { headers: this.headers() });
    if (!res.ok) return { state: "error", error: `Sume status ${res.status}: ${await res.text()}` };
    const s = (await res.json()).data || {};
    const st = String(s.sume_status || "").toLowerCase();
    if (st === "queued") return { state: "queued" };
    if (st === "processing") return { state: "running" };
    if (st === "failed" || st === "canceled") {
      let why = "no reason given";
      try {
        const j = await this.fetch(`${this.base}/v1/jobs/${jobId}`, { headers: this.headers() });
        if (j.ok) { const e = ((await j.json()).data || {}).job?.error; if (e) why = typeof e === "string" ? e : (e.message || JSON.stringify(e)); }
      } catch { /* the status alone is enough */ }
      // Sume refunds a failed or cancelled job in full.
      return { state: "error", noCharge: true, error: `Sume ${st}: ${why}. Sume refunds failed jobs, so nothing was billed.` };
    }
    if (st !== "completed") return { state: "running" }; // an unlisted status: keep waiting; jobs.js has a ceiling
    const rres = await this.fetch(responseUrl || `${this.base}/v1/jobs/${jobId}/result`, { headers: this.headers() });
    if (!rres.ok) return { state: "error", error: `Sume result ${rres.status}: ${await rres.text()}` };
    const r = ((await rres.json()).data || {}).result || {};
    const arts = Array.isArray(r.artifacts) ? r.artifacts : [];
    const art = arts.find((a) => /video/i.test(`${a.type || ""} ${a.content_type || ""}`)) || arts[0];
    if (!art || !art.url) return { state: "error", error: "Sume: completed but no video url", raw: r };
    return { state: "done", result: { videoUrl: art.url, actualUSD: null, raw: r } };
  }

  download(url, destAbs) { return local.download(url, destAbs); }
}
