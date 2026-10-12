// ElevenLabs, called directly with Shawn's own key (his choice, 2026-10-08:
// his account's voice library is searchable and his designed voices are
// there; fal's hosted voice changer only takes library voice names).
//
// Two calls:
//   listVoices  — the voices in his account ("My Voices", which includes any
//                 he added from the public library), searchable.
//   speechToSpeech — his recorded performance in, the same performance in a
//                 character's voice out. Synchronous: the audio comes back in
//                 the response body.
// Billing is in his plan's credits, not dollars, so nothing here prices a call.

const API = "https://api.elevenlabs.io";
export const STS_MODEL = "eleven_multilingual_sts_v2";
export const SFX_MODEL = "eleven_text_to_sound_v2";

// A silent 16-bit mono WAV of the given length — the mock's "sound".
export function silentWav(seconds, sr = 16000) {
  const n = Math.max(1, Math.round(seconds * sr)), b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

export class ElevenLabsDriver {
  constructor(config = {}) {
    this.name = "elevenlabs";
    this.key = config.key || process.env.ELEVENLABS_API_KEY || "";
    this.fetch = config.fetch || globalThis.fetch; // injectable for tests
  }

  status() {
    return this.key ? { ready: true, reason: "ElevenLabs key set" } : { ready: false, reason: "ELEVENLABS_API_KEY not set — add it to .env" };
  }

  async #get(pathAndQuery) {
    const res = await this.fetch(`${API}${pathAndQuery}`, { headers: { "xi-api-key": this.key } });
    if (!res.ok) throw await this.#error(res);
    return res.json();
  }

  async #error(res) {
    let detail = "";
    try { const j = await res.json(); detail = j?.detail?.message || j?.detail?.status || JSON.stringify(j?.detail || j); } catch { /* not json */ }
    const e = new Error(`ElevenLabs ${res.status}${detail ? `: ${detail}` : ""}`);
    e.status = res.status === 401 ? 401 : 502;
    return e;
  }

  async listVoices({ search = "", pageSize = 50 } = {}) {
    if (!this.key) throw Object.assign(new Error("ELEVENLABS_API_KEY not set — add it to .env"), { status: 503 });
    const q = new URLSearchParams({ page_size: String(pageSize), ...(search ? { search } : {}) });
    const j = await this.#get(`/v2/voices?${q}`);
    return (j.voices || []).map((v) => ({
      voiceId: v.voice_id,
      name: v.name,
      category: v.category || "",
      description: v.description || "",
      labels: v.labels || {},
      previewUrl: v.preview_url || null,
    }));
  }

  // Text to sound effect (room tone, ambience). duration 0.5–22 s; loop=true
  // asks for a clip that loops seamlessly. Returns a Buffer of mp3.
  async soundEffect({ text, seconds = 20, loop = true, promptInfluence = 0.3 }) {
    if (!this.key) throw Object.assign(new Error("ELEVENLABS_API_KEY not set — add it to .env"), { status: 503 });
    const t = String(text || "").trim();
    if (!t) throw Object.assign(new Error("the prompt is empty"), { status: 400 });
    if (t.length > 450) throw Object.assign(new Error(`the prompt is ${t.length} characters; ElevenLabs takes at most 450`), { status: 400 });
    const dur = Math.min(22, Math.max(0.5, Number(seconds) || 20));
    const res = await this.fetch(`${API}/v1/sound-generation?output_format=mp3_44100_192`, {
      method: "POST",
      headers: { "xi-api-key": this.key, "content-type": "application/json" },
      body: JSON.stringify({ text: t, duration_seconds: dur, loop: !!loop, prompt_influence: promptInfluence, model_id: SFX_MODEL }),
    });
    if (!res.ok) throw await this.#error(res);
    return Buffer.from(await res.arrayBuffer());
  }

  // audio: a Buffer of the recording; returns a Buffer of mp3.
  async speechToSpeech({ audio, filename = "performance.wav", voiceId, removeBackgroundNoise = false }) {
    if (!this.key) throw Object.assign(new Error("ELEVENLABS_API_KEY not set — add it to .env"), { status: 503 });
    if (!voiceId) throw Object.assign(new Error("no voice chosen for this character"), { status: 400 });
    const form = new FormData();
    form.append("audio", new Blob([audio]), filename);
    form.append("model_id", STS_MODEL);
    form.append("remove_background_noise", removeBackgroundNoise ? "true" : "false");
    const res = await this.fetch(`${API}/v1/speech-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_192`, {
      method: "POST", headers: { "xi-api-key": this.key }, body: form,
    });
    if (!res.ok) throw await this.#error(res);
    return Buffer.from(await res.arrayBuffer());
  }
}

// Free rehearsal: same shape, no network. "Voices" are placeholders and the
// "voiced" audio is the performance itself.
export class MockVoiceDriver {
  constructor() { this.name = "mock"; }
  status() { return { ready: true, reason: "mock — no network, no credits" }; }
  async listVoices({ search = "" } = {}) {
    const all = [
      { voiceId: "mock-gravel", name: "Mock Gravel", category: "mock", description: "placeholder", labels: {}, previewUrl: null },
      { voiceId: "mock-bright", name: "Mock Bright", category: "mock", description: "placeholder", labels: {}, previewUrl: null },
    ];
    return all.filter((v) => v.name.toLowerCase().includes(search.toLowerCase()));
  }
  async speechToSpeech({ audio }) { return Buffer.from(audio); }
  async soundEffect({ seconds = 20 }) { return silentWav(Math.min(22, Math.max(0.5, Number(seconds) || 20))); }
}
