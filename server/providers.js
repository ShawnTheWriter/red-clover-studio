// Connections: the services the app can use, grouped the way creators think of
// them, and the keys that switch them on. Keys live in the app's own .env
// (server/env.js loads it at startup); adding or removing one here also updates
// the running drivers, so no restart. Keys are never sent back to the browser:
// only whether one is set and its last four characters.
//
// `built: false` rows are listed so people can see what's coming, but can't be
// connected until the app has an adapter for them.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ENV_FILE = process.env.RCS_ENV_FILE || path.join(REPO, ".env");

export const CATEGORIES = [
  ["aggregator", "Aggregators", "One key, many models: video, images, lip sync, sound effects."],
  ["image", "Image generators", "Direct image APIs for storyboards and vault cards."],
  ["audio", "Audio", "Voices and dialogue."],
  ["llm", "LLM", "Drafting prompts, breaking scenes into shots, identity holds."],
];

export const PROVIDERS = [
  { id: "fal", name: "fal.ai", category: "aggregator", env: "FAL_KEY", built: true, covers: "Video (MiniMax, Seedance, Kling, Wan), GPT Image, lip sync, SFX · live pricing", keyUrl: "https://fal.ai/dashboard/keys" },
  { id: "openrouter", name: "OpenRouter", category: "aggregator", env: "OPENROUTER_API_KEY", built: true, covers: "Claude (and other LLMs) on one bill · used when there's no direct Anthropic key", keyUrl: "https://openrouter.ai/keys" },
  { id: "replicate", name: "Replicate", category: "aggregator", env: "REPLICATE_API_TOKEN", built: false, covers: "Adapter not built yet" },
  { id: "atlas", name: "Atlas Cloud", category: "aggregator", env: "ATLAS_API_KEY", built: true, covers: "Video: Seedance 2.5 (start/end frames and references) at Atlas's prices · balance check", keyUrl: "https://www.atlascloud.ai/docs/api-keys" },
  { id: "gemini", name: "Google Gemini (Nano Banana)", category: "image", env: "GEMINI_API_KEY", built: true, covers: "Storyboard stills and vault images", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "openai", name: "OpenAI (GPT Image, direct)", category: "image", env: "OPENAI_API_KEY", built: false, covers: "Adapter not built yet · GPT Image is available through fal today" },
  { id: "elevenlabs", name: "ElevenLabs", category: "audio", env: "ELEVENLABS_API_KEY", built: true, covers: "Character voices and dialogue", keyUrl: "https://elevenlabs.io/app/settings/api-keys" },
  { id: "anthropic", name: "Anthropic (Claude, direct)", category: "llm", env: "ANTHROPIC_API_KEY", built: true, covers: "Claude drafting tools · wins over OpenRouter when both are set", keyUrl: "https://console.anthropic.com/settings/keys" },
];

export const providerById = (id) => PROVIDERS.find((p) => p.id === id) || null;
export const mask = (k) => (k ? `…${String(k).slice(-4)}` : null);

// Rewrite one KEY=value line in .env (add, replace or remove), keeping every
// other line and comment as it was.
export async function writeEnvKey(name, value) {
  let txt = "";
  try { txt = await fs.readFile(ENV_FILE, "utf8"); } catch { txt = ""; }
  const lines = txt.split("\n");
  const rx = new RegExp(`^\\s*${name}\\s*=`);
  const kept = lines.filter((l) => !rx.test(l));
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  if (value) kept.push(`${name}=${value}`);
  await fs.writeFile(ENV_FILE, `${kept.join("\n")}\n`, { mode: 0o600 });
  // writeFile's mode only applies to a new file: keys are owner-only either way.
  await fs.chmod(ENV_FILE, 0o600);
}
