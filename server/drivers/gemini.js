// Gemini driver — Nano Banana image generation and editing.
//
// Mirrors what the nano-banana MCP does in-session, so the desk can batch what
// Claude does one at a time. `editImage` is the important one: it is step 2 of
// the proven method — re-stage a canonical reference per shot while an explicit
// identity hold keeps the face and wardrobe fixed.

import fs from "node:fs/promises";
import path from "node:path";
import { BaseDriver } from "./base.js";

const API = "https://generativelanguage.googleapis.com/v1beta/models";

export class GeminiDriver extends BaseDriver {
  constructor(config = {}) {
    super("gemini", config);
    this.key = config.key || process.env.GEMINI_API_KEY || "";
    this.model = config.model || "gemini-3.1-flash-image-preview";
  }

  status() {
    if (!this.key) return { ready: false, reason: "GEMINI_API_KEY not set — add it to .env" };
    return { ready: true, reason: "" };
  }

  async #call(parts) {
    const res = await fetch(`${API}/${this.model}:generateContent?key=${this.key}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }] }),
    });
    if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const out = await res.json();
    const cand = out?.candidates?.[0];
    const imagePart = (cand?.content?.parts || []).find((p) => p.inlineData || p.inline_data);
    if (!imagePart) {
      const text = (cand?.content?.parts || []).map((p) => p.text).filter(Boolean).join(" ");
      throw new Error(`gemini returned no image${text ? `: ${text.slice(0, 300)}` : ""}`);
    }
    const inline = imagePart.inlineData || imagePart.inline_data;
    return Buffer.from(inline.data, "base64");
  }

  async #writeOut(buf, outAbs) {
    await fs.mkdir(path.dirname(outAbs), { recursive: true });
    await fs.writeFile(outAbs, buf);
    return outAbs;
  }

  // Synchronous from the caller's point of view — the API returns the image
  // inline, so there is no job to poll.
  async generateImage({ prompt, outPath }) {
    if (!this.key) throw new Error("GEMINI_API_KEY not set");
    const buf = await this.#call([{ text: prompt }]);
    await this.#writeOut(buf, outPath);
    return { path: outPath, meta: { model: this.model } };
  }

  // Step 2 of the proven method. `referenceImages` are absolute paths; the
  // caller is responsible for putting the identity hold at the FRONT of the
  // prompt, because that ordering is what the Arm B test validated.
  async editImage({ prompt, referenceImages = [], outPath }) {
    if (!this.key) throw new Error("GEMINI_API_KEY not set");
    const parts = [];
    for (const ref of referenceImages) {
      const data = await fs.readFile(ref);
      parts.push({
        inlineData: {
          mimeType: /\.png$/i.test(ref) ? "image/png" : "image/jpeg",
          data: data.toString("base64"),
        },
      });
    }
    parts.push({ text: prompt });
    const buf = await this.#call(parts);
    await this.#writeOut(buf, outPath);
    return { path: outPath, meta: { model: this.model, references: referenceImages.length } };
  }
}
