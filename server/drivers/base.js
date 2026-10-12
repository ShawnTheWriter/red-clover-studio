// The driver adapter — the research document's "model-agnostic driver system",
// minus the ComfyUI driver it specifies. That one is omitted deliberately, not
// forgotten: ComfyUI, ControlNet, IP-Adapter and AnimateDiff all require CUDA,
// and this machine is Intel x86_64 with no NVIDIA GPU. The interface stays open
// so a future machine can add `comfy.js` without touching anything above it.

export class BaseDriver {
  constructor(name, config = {}) {
    this.name = name;
    this.config = config;
    // Does work on this driver cost real money? The cost ledger and the budget
    // cap only account for billable drivers — a rehearsal must not eat an
    // episode's cap. Every real backend leaves this true.
    this.billable = true;
  }

  // Is this driver usable right now? Returns { ready, reason }.
  // A driver missing credentials must say so rather than failing at call time.
  status() {
    return { ready: false, reason: "not implemented" };
  }

  // Make a still. { prompt, referenceImages?, aspectRatio?, outPath } -> { path, meta }
  async generateImage() {
    throw new Error(`${this.name}: generateImage not supported`);
  }

  // Make a clip from a still. { imagePath, prompt, seconds, modelId, outPath }
  // -> { jobId, ... } for async drivers, resolved later via getJob().
  async generateVideo() {
    throw new Error(`${this.name}: generateVideo not supported`);
  }

  // Re-time a finished clip's mouth to a recorded audio file.
  // { videoPath, audioPath, syncMode, modelId } -> { jobId, ... }, resolved via getJob().
  async generateLipsync() {
    throw new Error(`${this.name}: generateLipsync not supported`);
  }

  // Poll an async job. -> { state: queued|running|done|error, progress?, result?, error? }
  async getJob() {
    throw new Error(`${this.name}: getJob not supported`);
  }
}

export const JOB_STATES = ["queued", "running", "done", "error", "cancelled"];
