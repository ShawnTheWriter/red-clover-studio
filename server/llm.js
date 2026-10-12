// Claude in the studio (Shawn, 2026-10-09): two helpers that READ the
// episode and return suggestions — nothing here writes a shot, a prompt or a
// take. The browser shows the result and Shawn chooses what to keep.
//
//   draftPrompt  — a video prompt for one shot, written for the chosen video
//                  model from that model's guide (guides/<style>.md), the
//                  shot's fields and its approved start/end storyboards.
//   proposeShots — a provisional shot list for one scene from the script.
//
// Every call is paid (Anthropic API, billed per token). The cost comes back
// from the response's usage and goes into the episode ledger as its own
// "llm" entry, so it counts against the cap like any other spend.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import * as store from "./store.js";
import { thumbnail } from "./thumbs.js";
import { videoModel } from "./rates.js";
import { recordLlmCharge, ledgerState } from "./jobs.js";
import { resolveStartEndBeats, resolveVideoPrompt, usableHold } from "../shared/prompts.js";
import { parseScreenplay } from "../shared/screenplay.js";
import { SIZES, ANGLES, MOVES, LENSES } from "../shared/grammar.js";
import { newShot, newBeat, renumberScene } from "../shared/schema.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Anthropic first-party prices, USD per million tokens (claude-api skill
// model table, cached 2026-10-06). Cache writes bill at 1.25x input, cache
// reads at the listed rate. Thinking is billed inside output_tokens.
export const LLM_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", inPerM: 4, outPerM: 20, cacheReadPerM: 0.2, fallbacks: true },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", inPerM: 2, outPerM: 10, cacheReadPerM: 0.2, fallbacks: true },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", inPerM: 0.1, outPerM: 0.5, cacheReadPerM: 0.01, fallbacks: false },
];
export const DEFAULT_LLM = "claude-opus-5-5";
const llmModel = (id) => LLM_MODELS.find((m) => m.id === id) || null;

export function usageUSD(modelId, usage = {}) {
  const m = llmModel(modelId) || LLM_MODELS[0];
  const inTok = usage.input_tokens || 0;
  const write = usage.cache_creation_input_tokens || 0;
  const read = usage.cache_read_input_tokens || 0;
  const out = usage.output_tokens || 0;
  return (inTok * m.inPerM + write * m.inPerM * 1.25 + read * m.cacheReadPerM + out * m.outPerM) / 1e6;
}

// Claude directly (Anthropic key) or through OpenRouter (OpenRouter key), same
// models and prompts. A direct key wins when both are set.
export function provider() {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  return null;
}
export function status() {
  const p = provider();
  return p
    ? { ready: true, provider: p }
    : { ready: false, reason: "Connect Claude in Setup → Connect services: an Anthropic key (ANTHROPIC_API_KEY) or an OpenRouter key (OPENROUTER_API_KEY)." };
}
// "claude-opus-5-5" -> "anthropic/claude-opus-5.5" (OpenRouter's naming).
export function openRouterId(id) { return `anthropic/${String(id).replace(/-(\d+)-(\d+)$/, "-$1.$2")}`; }

let client = null;
function getClient() {
  if (!status().ready) throw Object.assign(new Error(status().reason), { status: 400 });
  // RCS_ANTHROPIC_BASE_URL points tests at a local fake server.
  if (!client) client = new Anthropic({ baseURL: process.env.RCS_ANTHROPIC_BASE_URL || undefined });
  return client;
}
export function resetClientForTests() { client = null; }

// One structured call. The system prompt is cached (it is the same for every
// shot of a task), the volatile shot data goes in the user turn.
async function callClaude(modelId, { system, content, schema, effort }) {
  const m = llmModel(modelId);
  if (!m) throw Object.assign(new Error(`unknown Claude model ${modelId}`), { status: 400 });
  if (provider() === "openrouter") return callOpenRouter(m, { system, content, schema, effort });
  const params = {
    model: m.id,
    max_tokens: 16000,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
    output_config: { effort, format: { type: "json_schema", schema } },
  };
  let res;
  try {
    // Opus/Sonnet 5.5: if a safety classifier declines, the API re-runs the
    // request on a fallback model inside the same call.
    res = m.fallbacks
      ? await getClient().beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
      : await getClient().messages.create(params);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw Object.assign(new Error("Anthropic rejected the API key — check ANTHROPIC_API_KEY in .env."), { status: 400 });
    if (e instanceof Anthropic.RateLimitError) throw Object.assign(new Error("Anthropic rate limit — wait a minute and try again."), { status: 429 });
    if (e instanceof Anthropic.BadRequestError) throw Object.assign(new Error(`Anthropic refused the request: ${e.message}`), { status: 400 });
    if (e instanceof Anthropic.APIError) throw Object.assign(new Error(`Anthropic error ${e.status}: ${e.message}`), { status: 502 });
    throw e;
  }
  const usd = usageUSD(res.model || m.id, res.usage);
  if (res.stop_reason === "refusal") {
    const why = res.stop_details ? `${res.stop_details.category || "policy"}: ${res.stop_details.explanation || ""}` : "policy";
    throw Object.assign(new Error(`Claude declined this request (${why}).`), { status: 422, usd, usage: res.usage, model: res.model });
  }
  if (res.stop_reason === "max_tokens") throw Object.assign(new Error("Claude ran out of room before finishing — try again."), { status: 502, usd, usage: res.usage, model: res.model });
  const text = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let data;
  try { data = JSON.parse(text); } catch { throw Object.assign(new Error("Claude's answer was not valid JSON."), { status: 502, usd, usage: res.usage, model: res.model }); }
  return { data, usd, usage: res.usage, model: res.model || m.id };
}

// The same structured call through OpenRouter's OpenAI-style chat API.
// Images go as data URLs; the JSON schema goes as response_format; the cost
// comes back in usage.cost (OpenRouter's own figure) when it's reported.
async function callOpenRouter(m, { system, content, schema, effort }) {
  const base = process.env.RCS_OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
  const parts = content.map((b) => (b.type === "image"
    ? { type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }
    : { type: "text", text: b.text }));
  const body = {
    model: openRouterId(m.id),
    max_tokens: 16000,
    messages: [{ role: "system", content: system }, { role: "user", content: parts }],
    response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema } },
    reasoning: { effort },
    usage: { include: true },
  };
  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "content-type": "application/json", "x-title": "Red Clover Studio" },
      body: JSON.stringify(body),
    });
  } catch (e) { throw Object.assign(new Error(`OpenRouter unreachable: ${e.message}`), { status: 502 }); }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (out.error && out.error.message) || `HTTP ${res.status}`;
    const status = res.status === 401 ? 400 : res.status === 402 ? 402 : res.status === 429 ? 429 : 502;
    const why = res.status === 401 ? "OpenRouter rejected the key — check it in Connect services." : res.status === 402 ? "OpenRouter says the account is out of credit." : `OpenRouter error: ${msg}`;
    throw Object.assign(new Error(why), { status });
  }
  const u = out.usage || {};
  const usage = { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0, cache_read_input_tokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0 };
  const usd = Number.isFinite(u.cost) ? u.cost : usageUSD(m.id, usage);
  const choice = (out.choices || [])[0] || {};
  const msg = choice.message || {};
  if (msg.refusal) throw Object.assign(new Error(`Claude declined this request: ${msg.refusal}`), { status: 422, usd, usage, model: m.id });
  if (choice.finish_reason === "length") throw Object.assign(new Error("Claude ran out of room before finishing — try again."), { status: 502, usd, usage, model: m.id });
  let data;
  try { data = JSON.parse(msg.content || ""); } catch { throw Object.assign(new Error("Claude's answer was not valid JSON."), { status: 502, usd, usage, model: m.id }); }
  return { data, usd, usage, model: m.id, via: "openrouter" };
}

// Charge the ledger whether the call succeeded or failed after being billed.
// `shotId` (optional) ties the charge to a shot for the per-shot cost breakdown.
async function charged(dir, task, llm, fn, shotId = null) {
  const led = (await store.loadEpisode(dir)).ledger || {};
  const remaining = (led.budgetCapUSD ?? Infinity) - (led.spentUSD || 0);
  if (remaining < 0.5) throw Object.assign(new Error(`The episode cap leaves $${Math.max(0, remaining).toFixed(2)} — raise the cap to use Claude.`), { status: 400 });
  try {
    const r = await fn();
    await recordLlmCharge(dir, { task, model: r.model, usd: r.usd, usage: r.usage, shotId, driver: r.via || "anthropic" });
    return r;
  } catch (e) {
    if (e.usd) await recordLlmCharge(dir, { task: `${task} (failed)`, model: e.model || llm, usd: e.usd, usage: e.usage, shotId, driver: provider() || "anthropic" });
    throw e;
  }
}

async function imageBlock(rel) {
  const abs = store.safeResolve(rel);
  const jpg = await thumbnail(abs, 1024);
  if (!jpg) return null;
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await fs.readFile(jpg)).toString("base64") } };
}

async function guideFor(style) {
  const name = style || "generic";
  try { return await fs.readFile(path.join(REPO, "guides", `${name}.md`), "utf8"); }
  catch { return await fs.readFile(path.join(REPO, "guides", "generic.md"), "utf8"); }
}

const characterNotes = (ep, names) => (ep.assets || [])
  .filter((a) => a.type === "character" && !a.angle && (!names || names.some((n) => a.name.toLowerCase().includes(String(n).toLowerCase()) || String(n).toLowerCase().includes(a.name.split(" ")[0].toLowerCase()))))
  .map((a) => ({ name: a.name, looks: usableHold(a.identityHold) }));

// Paid output is kept on the episode (no undo snapshot, like the ledger) until
// it is used or discarded, so it shows in the app however the call was made.
export async function keepResult(dir, kind, key, result) {
  return store.withEpisode(dir, (ep) => {
    ep.claude = ep.claude || { drafts: {}, proposals: {} };
    ep.claude[kind] = ep.claude[kind] || {};
    if (result) ep.claude[kind][key] = result; else delete ep.claude[kind][key];
    return true;
  });
}

// ---------- draft a video prompt ----------

const PROMPT_SYSTEM = `You write video-generation prompts for Red Clover Studios, an AI microdrama studio. The creator (a screenwriter) gives you one shot: its fields, the approved storyboard frames the video model will receive, and the prompting guide for the video model that will render it.

Write the prompt that model should receive for this shot, following its guide exactly.

Rules:
- Serve the creator's intent. Every action, line and sound must come from the shot's fields, the storyboard frames or the creator's note. Never add story events, props, characters or dialogue that are not there.
- The video model sees only the frames, not names. Refer to people by what is visible and where they are in frame (e.g. "the red-haired woman in the foreground, seen from behind"), never by character name, except that you may keep a name inside the creator's own wording when nothing else identifies the person.
- Describe motion between the frames, not a static picture. Match direction, handedness and which way things move to what the frames show (doors, turns, entrances).
- Keep spoken lines exactly as written. Do not add lines.
- If the shot asks for something the model is likely to get wrong, or the frames contradict the fields, say so in notes instead of silently changing the shot.
- notes: short, plain sentences for the creator — what you changed from their current prompt and why, and any risks. Empty if nothing to say.`;

const PROMPT_SCHEMA = {
  type: "object",
  properties: {
    prompt: { type: "string" },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["prompt", "notes"],
  additionalProperties: false,
};

export async function draftPrompt(dir, { shotId, videoModelId, llm = DEFAULT_LLM, intent = "", seconds = null }) {
  const ep = await store.loadEpisode(dir);
  const shot = ep.shots.find((s) => s.id === shotId);
  if (!shot) throw Object.assign(new Error("shot not found"), { status: 404 });
  const vm = videoModel(videoModelId);
  if (!vm) throw Object.assign(new Error(`unknown video model ${videoModelId}`), { status: 400 });
  if (vm.inputMode === "reference") throw Object.assign(new Error("Reference mode builds its own prompt from the images — drafting is for start/end-frame models."), { status: 400 });

  const guide = await guideFor(vm.promptStyle);
  const { start, end } = resolveStartEndBeats(shot);
  const content = [];
  if (start && start.frame && start.frame.path) {
    const b = await imageBlock(start.frame.path);
    if (b) content.push({ type: "text", text: "START FRAME (the video's first frame):" }, b);
  }
  if (end && end.frame && end.frame.path && (vm.imageParams || []).length > 1) {
    const b = await imageBlock(end.frame.path);
    if (b) content.push({ type: "text", text: "END FRAME (the video's last frame):" }, b);
  }
  const scene = (ep.scenes || []).find((s) => String(s.number) === String(shot.sceneNum));
  const speaking = [];
  for (const b of shot.beats || []) {
    const d = b.dialogue;
    if (!d || !d.line || !d.line.trim()) continue;
    const a = (ep.assets || []).find((x) => x.id === d.charId);
    speaking.push({ speaker: a ? a.name : "unknown", delivery: d.delivery || "", line: d.line.trim() });
  }
  const brief = {
    video_model: vm.label,
    clip_seconds: seconds || (shot.remaster && shot.remaster.targetSeconds) || null,
    aspect: ep.fmt,
    episode_style: ep.style || "",
    scene_heading: scene ? scene.heading : `${shot.intext} ${shot.loc} - ${shot.time}`,
    shot_label: shot.label,
    subjects: shot.subjects,
    action: shot.action,
    storyboard_descriptions: (shot.beats || []).filter((b) => b.keyframe && b.desc).map((b) => b.desc),
    camera: { size: SIZES[shot.size] || shot.size, angle: ANGLES[shot.angle] || shot.angle, lens: LENSES[shot.lens] || shot.lens, move: MOVES[shot.move] || shot.move || "static" },
    dialogue: speaking,
    sound: shot.audio || (shot.beats || []).map((b) => b.audio).filter(Boolean).join("; "),
    music: shot.music || null,
    characters_in_frame_reference: characterNotes(ep, (shot.subjects || "").split(/,|&| and /).map((s) => s.trim()).filter(Boolean)),
    creators_current_prompt: resolveVideoPrompt(shot, ep, { style: vm.promptStyle || null }).text,
    creators_note: intent || "",
  };
  content.push({ type: "text", text: `SHOT:\n${JSON.stringify(brief, null, 2)}` });
  const system = `${PROMPT_SYSTEM}\n\nPROMPTING GUIDE FOR ${vm.label}:\n${guide}`;

  const r = await charged(dir, `prompt ${shot.sceneNum}${shot.shotCode}`, llm, () =>
    callClaude(llm, { system, content, schema: PROMPT_SCHEMA, effort: "medium" }), shot.id);
  const result = { prompt: r.data.prompt, notes: r.data.notes || [], usd: r.usd, model: r.model, videoModelId, at: new Date().toISOString() };
  await keepResult(dir, "drafts", shot.id, result);
  return { ...result, usage: r.usage, ledger: ledgerState(await store.loadEpisode(dir)) };
}

// ---------- propose a shot list for a scene ----------

const SHOTS_SYSTEM = `You are a first assistant director breaking a screenplay scene into shots for a vertical (9:16) AI-generated microdrama. Each shot will be generated as a separate 2-10 second clip by an image-to-video model from a storyboard frame, then cut together.

Rules:
- Cover only what the scene's text contains. Do not invent events, characters, props or dialogue. Every spoken line in the scene belongs to exactly one shot, word for word.
- One clear action per shot; a shot that needs a big change of angle or place is two shots. Keep the 180-degree line between characters in a dialogue exchange.
- Favour what AI video does well: one subject moving simply, a locked or gently moving camera. Flag in "risk" anything it tends to get wrong (hands on small objects, doors, fast crowds, text on screen).
- seconds: what the shot needs on screen, 2-10.
- size, angle and move must use the given codes.
- If the creator already has shots in this scene, propose the full list anyway and use "matches_existing" to name the existing shot label it replaces, or "" for a new one.
- notes: short plain sentences for the creator about choices you made or questions the script leaves open.
- PREVIOUS SCENE (when given) is context only, for continuity: weather, light, wardrobe, where people and props are, what just happened. Never shoot it, never move its dialogue into this scene, and don't ask about anything it already answers. If this scene's heading says CONTINUOUS, it picks up the instant the previous one ends. NEXT SCENE HEADING is only there so the last shot can hand off cleanly.`;

const SHOTS_SCHEMA = {
  type: "object",
  properties: {
    shots: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          size: { type: "string", enum: Object.keys(SIZES) },
          angle: { type: "string", enum: Object.keys(ANGLES) },
          move: { type: "string", enum: Object.keys(MOVES) },
          subjects: { type: "string" },
          action: { type: "string" },
          dialogue: {
            type: "array",
            items: {
              type: "object",
              properties: { character: { type: "string" }, line: { type: "string" }, delivery: { type: "string" } },
              required: ["character", "line", "delivery"],
              additionalProperties: false,
            },
          },
          sound: { type: "string" },
          seconds: { type: "number" },
          risk: { type: "string" },
          matches_existing: { type: "string" },
        },
        required: ["label", "size", "angle", "move", "subjects", "action", "dialogue", "sound", "seconds", "risk", "matches_existing"],
        additionalProperties: false,
      },
    },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["shots", "notes"],
  additionalProperties: false,
};

const norm = (h) => String(h || "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();

// The scene's own script text, matched by heading (the episode's scene numbers
// follow the cut after Organize; the script's include an untitled opening).
export async function sceneScript(ep, scene) {
  if (!ep.scriptPath) throw Object.assign(new Error("This episode has no script file linked (Development → Find scripts)."), { status: 400 });
  const text = await store.readScriptFile(ep.scriptPath);
  const parsed = parseScreenplay(text, ep.scriptPath);
  const same = parsed.scenes.filter((s) => norm(s.heading) === norm(scene.heading));
  if (same.length === 1) return same[0].text;
  const byNum = parsed.scenes.find((s) => String(s.number) === String(scene.scriptNumber || ""));
  if (byNum && (!same.length || same.includes(byNum))) return byNum.text;
  if (same.length) return same[0].text;
  throw Object.assign(new Error(`Couldn't find "${scene.heading}" in ${path.basename(ep.scriptPath)}.`), { status: 404 });
}

// The scene before this one, for continuity (2026-10-12 test: broken down on
// its own, scene 2 asked whether it was still raining when scene 1 said so).
// Its script text (trimmed), and its shots — or, when it has none yet, the
// shots Claude proposed for it (the batch breakdown runs scenes in order).
const PREV_SCRIPT_CHARS = 2500;
export async function previousSceneContext(ep, scene) {
  const order = [...(ep.scenes || [])].filter((s) => s.number !== "X").sort((a, b) => Number(a.number) - Number(b.number));
  const i = order.findIndex((s) => s.id === scene.id);
  const prev = i > 0 ? order[i - 1] : null;
  const next = i >= 0 && i < order.length - 1 ? order[i + 1] : null;
  if (!prev) return { previous: null, nextHeading: next ? next.heading : "" };
  let script = "";
  try { script = await sceneScript(ep, prev); } catch { script = ""; }
  if (script.length > PREV_SCRIPT_CHARS) script = `…${script.slice(-PREV_SCRIPT_CHARS)}`; // its ending matters most
  const own = (ep.shots || []).filter((s) => String(s.sceneNum) === String(prev.number)).map((s) => s.label || s.action).filter(Boolean);
  const proposed = (((ep.claude || {}).proposals || {})[prev.id] || {}).shots || [];
  const shots = own.length ? own : proposed.map((x) => x.label || x.action).filter(Boolean);
  return { previous: { heading: prev.heading, script, shots, shotsSource: own.length ? "creator" : proposed.length ? "claude-proposal" : "none" }, nextHeading: next ? next.heading : "" };
}

export async function proposeShots(dir, { sceneNum, llm = DEFAULT_LLM, intent = "" }) {
  const ep = await store.loadEpisode(dir);
  const scene = (ep.scenes || []).find((s) => String(s.number) === String(sceneNum));
  if (!scene) throw Object.assign(new Error(`scene ${sceneNum} not found`), { status: 404 });
  const script = await sceneScript(ep, scene);
  const ctx = await previousSceneContext(ep, scene);
  const existing = ep.shots.filter((s) => String(s.sceneNum) === String(sceneNum)).map((s) => ({ code: `${s.sceneNum}${s.shotCode}`, label: s.label, action: s.action }));
  const brief = {
    scene_heading: scene.heading,
    episode_style: ep.style || "",
    characters: characterNotes(ep, null),
    existing_shots: existing,
    creators_note: intent || "",
  };
  const prevText = ctx.previous
    ? `PREVIOUS SCENE (context only — do not shoot it): ${ctx.previous.heading}\n${ctx.previous.script || "(script text not found)"}${ctx.previous.shots.length ? `\nIts shots${ctx.previous.shotsSource === "claude-proposal" ? " (proposed, not yet approved)" : ""}: ${ctx.previous.shots.join(" / ")}` : ""}\n\n`
    : "";
  const nextText = ctx.nextHeading ? `\n\nNEXT SCENE HEADING: ${ctx.nextHeading}` : "";
  const content = [{ type: "text", text: `${prevText}SCENE SCRIPT (break this one down):\n${script}\n\nCONTEXT:\n${JSON.stringify(brief, null, 2)}${nextText}` }];
  const r = await charged(dir, `shot list scene ${sceneNum}`, llm, () =>
    callClaude(llm, { system: SHOTS_SYSTEM, content, schema: SHOTS_SCHEMA, effort: "high" }));
  const result = { shots: r.data.shots || [], notes: r.data.notes || [], usd: r.usd, model: r.model, sceneNum: String(sceneNum), at: new Date().toISOString() };
  await keepResult(dir, "proposals", scene.id, result);
  return { ...result, usage: r.usage, ledger: ledgerState(await store.loadEpisode(dir)) };
}

// Add the proposals Shawn ticked, at the end of their scene (letters follow
// position). Each line attaches to a beat of the new shot, with its speaker
// matched to a character in the Identity Vault where one fits. Pure: the
// route runs it inside edit(), so Undo removes the added shots.
export function addProposedShots(ep, sceneNumIn, proposals) {
  const sceneNum = String(sceneNumIn);
  const scene = (ep.scenes || []).find((s) => String(s.number) === sceneNum) || {};
  const chars = (ep.assets || []).filter((a) => a.type === "character" && !a.angle);
  const who = (name) => {
    const n = String(name || "").toLowerCase().trim();
    return chars.find((a) => a.name.toLowerCase() === n)
      || chars.find((a) => a.name.toLowerCase().split(/\s+/).some((w) => w.length > 2 && n.split(/\s+/).includes(w))) || null;
  };
  const added = [];
  for (const p of proposals) {
    const shot = newShot({
      sceneId: scene.id || null, sceneNum, shotCode: "z",
      intext: scene.intext || "INT.", loc: scene.loc || "", time: scene.time || "DAY", location: scene.loc || "",
      label: p.label || "", size: SIZES[p.size] ? p.size : "MS", angle: ANGLES[p.angle] ? p.angle : "eye", move: MOVES[p.move] ? p.move : "static",
      subjects: p.subjects || "", action: p.action || "", audio: p.sound || "",
      notes: [p.risk ? `Risk (Claude): ${p.risk}` : "", p.seconds ? `Suggested length: ${p.seconds} s` : ""].filter(Boolean).join("\n"),
    });
    (p.dialogue || []).filter((d) => d && d.line).forEach((d, i) => {
      const a = who(d.character);
      const beat = i === 0 ? shot.beats[0] : newBeat({ role: "beat", keyframe: false, desc: `line: ${d.line.slice(0, 40)}` });
      beat.dialogue = { charId: a ? a.id : null, line: d.line, delivery: d.delivery || "neutral" };
      if (!a) shot.notes = `${shot.notes ? `${shot.notes}\n` : ""}Speaker "${d.character}" isn't in the Identity Vault yet.`;
      if (i > 0) shot.beats.push(beat);
    });
    let at = ep.shots.length;
    for (let i = ep.shots.length - 1; i >= 0; i--) if (String(ep.shots[i].sceneNum) === sceneNum) { at = i + 1; break; }
    ep.shots.splice(at, 0, shot);
    renumberScene(ep.shots, sceneNum);
    added.push(shot.id);
  }
  return added;
}

// ---------- vault: identity holds and asset prompts ----------
//
// Two drafts for a vault card, both returned for the creator to edit and save
// (nothing is written here):
//   kind "hold"   — the identity/continuity hold appended to every prompt the
//                   asset feeds, read from the card's image when it has one.
//   kind "prompt" — an image-generation prompt for a new reference image.
// Sources are the card itself, the series bible and the script passages that
// mention it. Never story facts from anywhere else.
const ASSET_SYSTEM = `You help a filmmaker keep characters, locations and props visually consistent across AI-generated shots.

Rules:
- Use only what the sources show or say: the attached image, the series bible excerpt, the script passages and the card's fields. Never invent backstory, names, wardrobe or features that aren't there. If the sources are thin, write less and say so in notes.
- Describe what a camera sees: face, build, hair, skin, age range, wardrobe silhouette and colours, distinctive marks; for places, architecture, materials, palette, light sources, period; for props, shape, material, colour, wear, scale.
- Plain, concrete words. No camera directions in a hold. No character names inside a hold except the subject's own.
- notes: short sentences for the creator — anything ambiguous, any conflict between the image and the text, anything you left out on purpose.`;

const HOLD_GUIDE = {
  character: `Write an IDENTITY HOLD: 1–3 sentences that start "Keep this exact character:" and list the fixed visual traits that must never drift (face and bone structure, eyes, hair, build, signature wardrobe items with colours). Present tense, no story.`,
  location: `Write a CONTINUITY HOLD: 1–3 sentences that start "Keep this exact location:" and list what must stay the same between shots (architecture, materials, layout landmarks, palette, practical light sources, period details). No people.`,
  prop: `Write a CONTINUITY HOLD: 1–2 sentences that start "Keep this exact prop:" and list shape, material, colour, wear and scale.`,
};
const PROMPT_GUIDE = {
  character: `Write an IMAGE PROMPT for a clean character reference image: the full figure or a head-and-shoulders portrait as the creator's note asks (default: full figure, front view), neutral seamless backdrop, even soft light, no props unless they are part of the costume, no text. Describe the character concretely from the sources.`,
  location: `Write an IMAGE PROMPT for a clean location plate: a wide establishing view of the empty location, no people, natural light for the time of day the sources give, no text. Describe the place concretely from the sources.`,
  prop: `Write an IMAGE PROMPT for a clean prop reference: the object alone, centred on a neutral backdrop, soft even light, no hands, no text.`,
};
const ASSET_SCHEMA = {
  type: "object",
  properties: { text: { type: "string" }, notes: { type: "array", items: { type: "string" } } },
  required: ["text", "notes"],
  additionalProperties: false,
};

// Script paragraphs that mention the asset by name, first name or alias.
async function scriptMentions(ep, asset, cap = 5000) {
  if (!ep.scriptPath) return "";
  let text = "";
  try { text = await store.readScriptFile(ep.scriptPath); } catch { return ""; }
  const names = [asset.name, asset.name.split(/\s+/)[0], ...(asset.aliases || [])]
    .map((n) => String(n || "").trim()).filter((n) => n.length > 2);
  if (!names.length) return "";
  const rx = new RegExp(names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
  const out = [];
  let len = 0;
  for (const para of text.split(/\n\s*\n/)) {
    if (!rx.test(para)) continue;
    const t = para.trim();
    if (len + t.length > cap) break;
    out.push(t); len += t.length;
  }
  return out.join("\n\n");
}

export async function draftAsset(dir, { assetId, kind = "hold", intent = "", llm = DEFAULT_LLM }) {
  if (!["hold", "prompt"].includes(kind)) throw Object.assign(new Error("kind must be hold or prompt"), { status: 400 });
  const ep = await store.loadEpisode(dir);
  const asset = (ep.assets || []).find((a) => a.id === assetId);
  if (!asset) throw Object.assign(new Error("asset not found"), { status: 404 });
  const group = (ep.assets || []).filter((a) => a.type === asset.type && a.name.trim().toLowerCase() === asset.name.trim().toLowerCase());
  const type = HOLD_GUIDE[asset.type] ? asset.type : "prop";

  const content = [];
  const withImage = group.find((a) => a.path);
  if (withImage) {
    const b = await imageBlock(withImage.path);
    if (b) content.push({ type: "text", text: `REFERENCE IMAGE of ${asset.name}${withImage.angle ? ` (${withImage.angle})` : ""}:` }, b);
  }
  let bible = null;
  try { bible = await store.readBible(path.dirname(ep.dir)); } catch { bible = null; }
  const brief = {
    task: kind === "hold" ? HOLD_GUIDE[type] : PROMPT_GUIDE[type],
    asset: { type: asset.type, name: asset.name, aliases: asset.aliases || [], angles: group.map((a) => a.angle).filter(Boolean), current_hold: usableHold(asset.identityHold) || "" },
    episode_style: ep.style || "",
    creator_note: intent || "",
    series_bible_excerpt: bible ? bible.slice(0, 8000) : "",
    script_mentions: await scriptMentions(ep, asset),
  };
  content.push({ type: "text", text: JSON.stringify(brief, null, 2) });

  const r = await charged(dir, `asset ${kind} ${asset.name}`, llm, () =>
    callClaude(llm, { system: ASSET_SYSTEM, content, schema: ASSET_SCHEMA, effort: "low" }));
  // Kept on the episode like shot drafts, so a paid draft shows in every
  // browser until it is saved, used or discarded.
  await keepResult(dir, "assets", `${kind}:${assetId}`, { kind, assetId, text: r.data.text, notes: r.data.notes || [], usd: r.usd, model: r.model, at: new Date().toISOString() });
  return { kind, assetId, text: r.data.text, notes: r.data.notes || [], usd: r.usd, model: r.model, usedImage: !!withImage, usedBible: !!bible, ledger: ledgerState(await store.loadEpisode(dir)) };
}
