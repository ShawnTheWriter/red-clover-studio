// Mock driver — exercises the queue, the fan-out and the ledger without
// spending a cent.
//
// This is not decoration. Everything the cost cap does is only trustworthy if
// it has been watched working, and watching it work with the real drivers means
// paying to find out. The mock has the same async shape as fal (submit, poll,
// complete after a delay) so the queue code under test is the same code that
// runs in production, and it writes a real file so downstream steps are
// genuinely exercised.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BaseDriver } from "./base.js";

const jobs = new Map();

export class MockDriver extends BaseDriver {
  constructor(config = {}) {
    super("mock", config);
    // The console advertises this driver as "no spend"; the ledger has to agree.
    this.billable = false;
    this.latencyMs = config.latencyMs ?? 1500;
    this.failRate = config.failRate ?? 0;
  }

  status() { return { ready: true, reason: "mock — no spend, no network" }; }

  // Images: a copy of the first reference (or the app icon) stands in for a
  // generation. Same call shape as the real image drivers.
  async generateImage({ outPath }) { return this.editImage({ referenceImages: [], outPath }); }
  async editImage({ referenceImages = [], outPath }) {
    await new Promise((r) => setTimeout(r, Math.min(this.latencyMs, 600)));
    const src = referenceImages[0] || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "branding", "icon-concepts", "FINAL_chatgpt_source.png");
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.copyFile(src, outPath);
    return { path: outPath };
  }

  async generateVideo({ prompt, seconds, modelId }) {
    const jobId = `mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    jobs.set(jobId, {
      startedAt: Date.now(),
      willFail: Math.random() < this.failRate,
      modelId, seconds, prompt,
    });
    return { jobId, statusUrl: null, responseUrl: null, imageUrl: "mock://keyframe" };
  }

  // Same async shape as fal's lip sync; nothing is uploaded or paid for.
  async generateLipsync({ modelId, syncMode }) {
    const jobId = `mock_ls_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    jobs.set(jobId, { startedAt: Date.now(), willFail: Math.random() < this.failRate, modelId, syncMode });
    return { jobId, statusUrl: null, responseUrl: null };
  }

  async generateFinish({ modelId }) {
    const jobId = `mock_fin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    jobs.set(jobId, { startedAt: Date.now(), willFail: Math.random() < this.failRate, modelId });
    return { jobId, statusUrl: null, responseUrl: null };
  }

  async generateUpscale({ modelId }) {
    const jobId = `mock_up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    jobs.set(jobId, { startedAt: Date.now(), willFail: Math.random() < this.failRate, modelId });
    return { jobId, statusUrl: null, responseUrl: null };
  }

  async getJob({ jobId }) {
    const j = jobs.get(jobId);
    if (!j) return { state: "error", error: "unknown mock job" };
    const elapsed = Date.now() - j.startedAt;
    if (elapsed < this.latencyMs * 0.4) return { state: "queued" };
    if (elapsed < this.latencyMs) return { state: "running" };
    if (j.willFail) return { state: "error", error: "mock failure (injected)" };
    return { state: "done", result: { videoUrl: `mock://video/${jobId}.mp4`, actualUSD: null } };
  }

  // Writes a tiny placeholder so the download step and the version tray have a
  // real file to point at.
  async download(url, destAbs) {
    await fs.mkdir(path.dirname(destAbs), { recursive: true });
    await fs.writeFile(destAbs, `mock clip for ${url}\n`);
    return destAbs;
  }
}
