// Prompt builders, ported from Red Clover Production Desk.html onto schema v2.
//
// The wording here was tuned against real generations — the ABSOLUTE-anchor
// reference line, the negative block kept separate from the shot lines, the
// subject-agnostic size labels. Treat changes as a craft decision, not a refactor.

import {
  SIZES, LENSES, ANGLES, ANGLE_FX, MOVES, TREATMENTS,
  cap, frameBaseName, beatFrameName, secToTC, estBeatDuration,
} from "./grammar.js";
import { beatCam, beatAudio, beatTreatments } from "./schema.js";
import { blockingSentence } from "./blocking.js";

const ctx = (ep) => ({
  fmt: ep.fmt || "9:16",
  style: ep.style || "",
  ban: ep.ban || "",
  lean: !!ep.lean,
  assets: ep.assets || [],
});

export function refNames(shot, ep) {
  return (shot.refs || [])
    .map((id) => ((ep.assets || []).find((a) => a.id === id) || {}).name)
    .filter(Boolean);
}

// A vault CARD is every image with the same type and name: the main image plus its
// other costumes, angles and close-ups. A shot's refs hold the id of each image it
// uses, so it can point at a costume instead of the main image.
export const cardKey = (a) => `${a.type}:${String(a.name || "").trim().toLowerCase()}`;
// The card's default image: the first one that has a file.
export const cardMain = (records) => records.find((a) => a.path) || records[0];

export function refAssets(shot, ep) {
  return (ep.assets || []).filter((a) => (shot.refs || []).includes(a.id));
}

export function treatmentLines(shot, beat) {
  const ids = beatTreatments(shot, beat);
  const ph = ids.map((id) => {
    const t = TREATMENTS.find((x) => x.id === id);
    return t ? t.phrase : null;
  }).filter(Boolean);
  if (shot.custom && shot.custom.trim()) ph.push(shot.custom.trim());
  return ph;
}

export function camPhrase(camera) {
  let s = `Shot as ${SIZES[camera.size] || "a shot"} on ${LENSES[camera.lens] || "a lens"}, ${ANGLES[camera.angle] || "at eye level"}`;
  if (ANGLE_FX[camera.angle]) s += ANGLE_FX[camera.angle];
  return s;
}

export const aspectWord = (p) => (p.fmt === "9:16" ? "vertical 9:16" : "horizontal 16:9");

export function locPhrase(shot, p) {
  if (p.lean) {
    const lr = (p.assets || []).find((a) => a.type === "location" && (shot.refs || []).includes(a.id));
    if (lr) return `the ${lr.name}, as in the reference`;
  }
  return shot.location || "";
}

export function dialogueStr(beat, ep) {
  const d = beat && beat.dialogue;
  if (!d || !d.line || !d.line.trim()) return null;
  const a = (ep.assets || []).find((x) => x.id === d.charId);
  const name = a ? a.name : (d.charId || "Character");
  const bits = [
    d.delivery && d.delivery !== "neutral" ? d.delivery : "",
    a && a.voice ? a.voice : "",
  ].filter(Boolean).join(", ");
  return `${name}${bits ? ` (${bits})` : ""}: "${d.line.trim()}"`;
}

// The reference anchor line. Identity-hold phrasing from an approved asset is
// appended verbatim — this is the wording that survived the Arm B continuity test.
function refLineNano(shot, ep) {
  const assets = refAssets(shot, ep);
  if (!assets.length) return "";
  const names = assets.map((a) => a.name);
  let line = ` Use the provided reference image(s) — ${names.join(", ")} — as the ABSOLUTE anchor for character identity and the environment; do not restyle or reinterpret them.`;
  const holds = assets.map((a) => usableHold(a.identityHold)).filter(Boolean);
  if (holds.length) line += ` ${holds.join(" ")}`;
  return line;
}

function refLineGPT(shot, ep) {
  const names = refNames(shot, ep);
  return names.length ? ` Keep ${names.join(" and ")} consistent with the uploaded reference image(s).` : "";
}

function momentWord(role) {
  return role === "start" ? "the START of the shot"
    : role === "end" ? "the END of the shot"
    : role === "mid" ? "the MIDDLE of the shot"
    : "the shot";
}

// ---------- image prompts ----------

export function buildNano(shot, ep, beat = null) {
  const p = ctx(ep);
  const b = beat || (shot.beats || [])[0] || null;
  const camera = beatCam(shot, b);
  const dir = treatmentLines(shot, b);
  const dirBlock = dir.length ? `\nDIRECTION: ${dir.join("; ")}.` : "";
  const single = (shot.beats || []).filter((x) => x.keyframe).length <= 1;
  const head = single
    ? `Cinematic ${aspectWord(p)} storyboard frame${p.style ? `, ${p.style}` : ""}.`
    : `Cinematic ${aspectWord(p)} storyboard keyframe — ${momentWord(b && b.role)}${p.style ? `, ${p.style}` : ""}.`;
  const momentLine = single
    ? `ACTION: ${shot.action}.`
    : `MOMENT: ${(b && b.desc) || shot.action}.`;
  return `${head}
SUBJECT: ${shot.subjects}.
${momentLine}
LOCATION: ${locPhrase(shot, p)}.
CAMERA: ${camPhrase(camera)}.
LIGHTING: ${shot.lighting}.${shot.atmos ? `\nATMOSPHERE: ${shot.atmos}.` : ""}${dirBlock}${refLineNano(shot, ep)}
Photographic realism, consistent detail.
Negative: ${p.ban}.`;
}

export function buildGPT(shot, ep, beat = null) {
  const p = ctx(ep);
  const b = beat || (shot.beats || [])[0] || null;
  const camera = beatCam(shot, b);
  const dir = treatmentLines(shot, b);
  const dirS = dir.length ? ` Direction: ${dir.join("; ")}.` : "";
  const single = (shot.beats || []).filter((x) => x.keyframe).length <= 1;
  const moment = single ? shot.action : ((b && b.desc) || shot.action);
  return `A cinematic film still, ${aspectWord(p)}${p.style ? `, ${p.style}` : ""}. ${cap(shot.subjects)} — ${moment} — in ${locPhrase(shot, p)}. ${camPhrase(camera)}. ${cap(shot.lighting)}.${shot.atmos ? ` Mood: ${shot.atmos}.` : ""}${dirS} Photorealistic, richly detailed, filmic color grade, natural skin and fabric texture.${refLineGPT(shot, ep)} Avoid distortion of hands or faces, text, and watermarks.`;
}

// ---------- video prompts ----------

// The lean image-to-video JSON. Deliberately minimal: shot id, aspect, duration
// and the frame uploads are set at the generator, not prompted. Describes MOTION
// ONLY — the keyframe carries identity. This is the proven path.
export function buildVideo(shot, ep) {
  const p = ctx(ep);
  const beats = shot.beats || [];
  // Whole-shot semantics: one generation covers the shot, so the motion line is
  // the shot's action and the move is the shot default. Per-beat camera lives in
  // the timecoded script, which is the multi-setup path.
  const sfx = shot.audio || beats.map((b) => b.audio).filter(Boolean).join("; ");
  const music = shot.music || beats.map((b) => b.music).filter(Boolean)[0] || null;
  const dia = beats.map((b) => dialogueStr(b, ep)).filter(Boolean).join(" / ") || null;
  return JSON.stringify({
    subject_motion: [shot.subjects, shot.action].map((x) => (x || "").trim()).filter(Boolean).join(" — "),
    camera_move: MOVES[shot.move] || "static (locked-off)",
    audio: { dialogue: dia, sfx: sfx || "", music: music && String(music).trim() ? String(music).trim() : null },
    negative: p.ban,
  }, null, 2);
}

// The fuller Seedance JSON, for the single-camera-setup handoff.
export function buildSeed(shot, ep, beat = null) {
  const p = ctx(ep);
  const b = beat || (shot.beats || [])[0] || null;
  const camera = beatCam(shot, b);
  const audio = beatAudio(shot, b);
  const names = refNames(shot, ep);
  const o = {
    shot: frameBaseName(shot),
    duration_seconds: Math.round(shotDuration(shot)) || 5,
    aspect_ratio: p.fmt,
    subject: shot.subjects + (names.length ? ` (anchored to uploaded frame / refs: ${names.join(", ")})` : ""),
    action: (b && b.desc) || shot.action,
    environment: shot.location,
    camera: {
      move: MOVES[camera.move] || "static",
      angle: camera.angle,
      lens: (LENSES[camera.lens] || "").replace(/^a /, ""),
      framing: camera.size,
    },
    lighting: shot.lighting,
    audio: {
      dialogue: (shot.beats || []).map((x) => dialogueStr(x, ep)).filter(Boolean).join(" / ") || null,
      sfx: shot.audio || audio.sfx || "",
      music: shot.music || audio.music || null,
    },
    negative: p.ban,
  };
  const dir = treatmentLines(shot, b);
  if (dir.length) o.direction = dir.join("; ");
  return JSON.stringify(o, null, 2);
}

// ---------- timecoded Omni-Reference shot-script ----------

export function beatDuration(beat) {
  if (beat && beat.durationSec != null) return beat.durationSec;
  return estBeatDuration(beat && beat.desc);
}

export function shotDuration(shot) {
  return (shot.beats || []).reduce((t, b) => t + beatDuration(b), 0);
}

// v1 had to guess beats by splitting the action sentence, then hang dialogue and
// SFX on the last one. v2 walks the real beat list, so every beat carries its own
// camera header, its own dialogue and its own SFX.
export function draftTimecodeText(shot, ep) {
  const p = ctx(ep);
  const beats = (shot.beats || []).length ? shot.beats : [{ role: "start", desc: shot.action || "(describe the beat)" }];
  const sentence = (s) => (s || "").trim().replace(/[.!?]+$/, "") + ".";
  let t = 0;
  const lines = beats.map((b, i) => {
    const dur = beatDuration(b);
    const camera = beatCam(shot, b);
    const header = `${SIZES[camera.size] || "a shot"}, ${ANGLES[camera.angle] || "eye level"}, ${MOVES[camera.move] || "static"}`;
    const audio = beatAudio(shot, b);
    const bits = [sentence(b.desc || shot.action)];
    const dia = dialogueStr(b, ep);
    if (dia) bits.push(`Dialogue: ${sentence(dia)}`);
    if (audio.sfx && audio.sfx.trim()) bits.push(`SFX: ${sentence(audio.sfx)}`);
    if (audio.music) bits.push(`Music: ${sentence(audio.music)}`);
    const line = `[${secToTC(t)}-${secToTC(t + dur)}] Shot ${i + 1}${shot.label ? `: ${shot.label}` : ""} (${header}). ${bits.join(" ")}`;
    t += dur;
    return line;
  });
  const assets = refAssets(shot, ep);
  const assetMap = assets.length
    ? assets.map((a, i) => `@Image${i + 1} = ${a.name}${a.angle ? ` — ${a.angle}` : ""} (${a.type})`).join("\n")
    : "(no reference assets attached to this shot — add some to anchor identity)";
  const style = p.style || "cinematic, natural color grade";
  return `【Style】${style}
【Duration】${Math.round(t)} seconds · 【Aspect】${p.fmt}

Asset map:
${assetMap}

${lines.join("\n")}

Constraints (negative — keep in this separate block, don't fold into the lines above): ${p.ban}`;
}

// ---------- the video prompt actually sent ----------
//
// Two ways to prompt a clip, chosen per shot (shot.videoPromptMode):
//  - "direction" (default): plain-language shot direction — what moves and
//    how the camera moves. MOTION ONLY: the start frame carries identity, so
//    appearance is deliberately not described (the proven keyframe method).
//  - "timecoded": the beat-by-beat [00:00-00:02] script.
// resolveVideoPrompt is the ONE place both the Shots-list box and Generate
// get the text, so what's shown is what's sent. (Before this, Generate built
// a third, hidden prompt of its own.)
export function buildDirection(shot, ep) {
  const bits = [];
  // End with one full stop — unless it already ends a sentence inside quotes
  // (dialogue: "…the other thing.") where another stop would double up.
  const sentence = (x) => {
    const t = (x || "").trim();
    if (!t) return "";
    return /[.!?]["”’']$/.test(t) ? t : t.replace(/[.!?]*$/, ".");
  };
  if (shot.action) bits.push(sentence(shot.action));
  const beat = (shot.beats || []).find((b) => b.keyframe && b.frame && b.frame.approved)
    || (shot.beats || []).find((b) => b.keyframe) || null;
  if (beat && beat.desc && beat.desc.trim() !== (shot.action || "").trim()) bits.push(sentence(beat.desc));
  bits.push(shot.move && shot.move !== "static" ? `Camera: ${MOVES[shot.move] || shot.move.replace(/[_-]/g, " ")}.` : "Camera: locked off.");
  const dia = (shot.beats || []).map((b) => dialogueStr(b, ep)).filter(Boolean).join(" / ");
  if (dia) bits.push(`Dialogue: ${sentence(dia)}`);
  const sfx = shot.audio || (shot.beats || []).map((b) => b.audio).filter(Boolean).join("; ");
  if (sfx) bits.push(`Sound: ${sentence(sfx)}`);
  return bits.join(" ");
}

// fal's H3 Max guide (fal.ai/learn/tools/how-to-use-minimax-h3-max, read
// 2026-10-09), for models whose rates.js row says promptStyle "fal-brief":
// plain-English action; for a still, name what to KEEP (framing, light,
// setting) and the camera; spoken lines in double quotes with a delivery
// direction; "Sound:" as concrete sources; close with "No music, no
// on-screen text." (fal: "costs nothing if the model was never going to add
// any"). Expansion stays on for these models, so quotes become speech, not
// captions.
export function buildFalBrief(shot, ep) {
  const sentence = (x) => {
    const t = (x || "").trim();
    if (!t) return "";
    return /[.!?]["”’']$/.test(t) ? t : t.replace(/[.!?]*$/, ".");
  };
  const bits = [];
  if (shot.action) bits.push(sentence(shot.action));
  const beat = (shot.beats || []).find((b) => b.keyframe && b.frame && b.frame.approved)
    || (shot.beats || []).find((b) => b.keyframe) || null;
  if (beat && beat.desc && beat.desc.trim() !== (shot.action || "").trim()) bits.push(sentence(beat.desc));
  for (const b of shot.beats || []) {
    const d = b.dialogue;
    if (!d || !d.line || !d.line.trim()) continue;
    const a = (ep.assets || []).find((x) => x.id === d.charId);
    const who = a ? a.name : "The character";
    const how = [d.delivery && d.delivery !== "neutral" ? d.delivery : "", a && a.voice ? a.voice : ""].filter(Boolean).join(", ");
    bits.push(`${who} says${how ? `, ${how}` : ""}: "${d.line.trim()}"`);
  }
  const { end } = resolveStartEndBeats(shot);
  const still = end ? "start frame, and end on the end frame's composition" : "still";
  // "handheld" is a camera style, not a move: "the camera makes a handheld"
  // was sent on the 1c raid shots (2026-10-10).
  const cam = !shot.move || shot.move === "static"
    ? "keep the camera locked off throughout"
    : shot.move === "handheld" ? "the camera is handheld, with a slight natural shake"
    : `the camera makes a ${MOVES[shot.move] || shot.move.replace(/[_-]/g, " ")}`;
  bits.push(`Hold the framing, the light and the setting exactly as they are in the ${still}; ${cam}.`);
  const music = shot.music || (shot.beats || []).map((b) => b.music).filter(Boolean)[0] || null;
  const sfx = shot.audio || (shot.beats || []).map((b) => b.audio).filter(Boolean).join("; ");
  if (sfx) bits.push(`Sound: ${sfx.trim().replace(/[.!?]*$/, "")}.`);
  if (music) bits.push(`Music: ${sentence(String(music))}`);
  bits.push(music ? "No on-screen text." : "No music, no on-screen text.");
  return bits.join(" ");
}

// The asset map (@Image1 = …) only means something to a model that receives
// those reference images. The image-to-video models here get ONE start frame,
// so for them the map is stripped from what's sent (it stays in the box, for
// pasting into Seedance's own omni-reference UI).
export function stripAssetMap(text) {
  return String(text || "").replace(/\n?Asset map:\n[\s\S]*?(\n\s*\n|$)/, "\n");
}

export function videoMode(shot) {
  return shot.videoPromptMode === "timecoded" ? "timecoded" : "direction";
}

// The two approved keyframes that actually feed a video model's start/end
// image slots. A shot can carry several approved storyboards purely to
// compare combos (see shot.startBeatId/endBeatId in shared/schema.js) — this
// is the ONE place that picks the winning two, so the storyboard picker, the
// video pane, and the job queue that submits to fal never disagree. Auto
// (both ids null) uses the first approved keyframe as start and the last as
// end, matching the order they sit in on the board.
export function resolveStartEndBeats(shot) {
  const approved = (shot.beats || []).filter((b) => b.keyframe && b.frame && b.frame.approved && b.frame.path);
  if (!approved.length) return { start: null, end: null };
  const byId = (id) => approved.find((b) => b.id === id) || null;
  const start = (shot.startBeatId && byId(shot.startBeatId)) || approved[0];
  const endPool = approved.filter((b) => b.id !== start.id);
  const chosenEnd = shot.endBeatId && shot.endBeatId !== start.id ? byId(shot.endBeatId) : null;
  const end = chosenEnd || endPool[endPool.length - 1] || null;
  return { start, end };
}

// ---------- reference mode (Seedance omni-reference) ----------
//
// A "reference" video model (rates.js inputMode: "reference") takes MANY images,
// not a start and an end frame: every approved storyboard frame plus the
// shot's character/location/prop assets, addressed in the prompt as @Image1…
// Storyboard frames go first, in beat order, because they carry positions and
// blocking; asset images follow as identity anchors. This is the ONE place
// that decides the set and its wording — the Generate pane preview, the job
// queue and the driver all read it, so shown text == sent text and the list
// of images shown is the list of images uploaded.
export const MAX_REFERENCE_IMAGES = 12;

// An identity hold still showing the vault's template placeholders
// ("[character]", "[wardrobe items]") was never filled in: sending it puts
// literal brackets into the prompt (found on the face close-up assets,
// 2026-10-10). Only filled-in holds are sent.
export function usableHold(text) {
  const t = String(text || "").trim();
  return t && !/\[[a-z][a-z ,/-]*\]/i.test(t) ? t : "";
}

// Trim a description to `max` chars at a word boundary, never mid-word.
function clip(text, max) {
  const t = String(text || "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max).replace(/\s+\S*$/, "");
  return `${cut || t.slice(0, max)}…`;
}

// Reference videos (Blender previs, grey-box, any rehearsal clip) the shot has
// switched on, limited by the model's own rules (rates.js `refVideo`: param,
// max clips, per-clip and combined seconds). Models without `refVideo` take
// none. Returns the clips that will be sent and why any were left out.
export function refVideoSet(shot, limits) {
  const on = (shot.refVideos || []).filter((v) => v.use !== false && v.path);
  if (!limits) return { videos: [], skipped: on.map((v) => ({ v, why: "this model doesn't take reference video" })) };
  const videos = [], skipped = [];
  let total = 0;
  for (const v of on) {
    const sec = Number(v.seconds) || 0;
    if (videos.length >= limits.max) { skipped.push({ v, why: `this model takes at most ${limits.max}` }); continue; }
    if (sec && (sec < limits.minSec || sec > limits.maxSec)) { skipped.push({ v, why: `clips must be ${limits.minSec}–${limits.maxSec} s` }); continue; }
    if (sec && total + sec > limits.totalSec) { skipped.push({ v, why: `over ${limits.totalSec} s combined` }); continue; }
    total += sec;
    videos.push(v);
  }
  return { videos, skipped, seconds: total };
}

export function resolveReferenceSet(shot, ep, { max = MAX_REFERENCE_IMAGES } = {}) {
  const seen = new Set();
  const out = [];
  const add = (item) => { if (item.path && !seen.has(item.path)) { seen.add(item.path); out.push(item); } };
  const frames = (shot.beats || []).filter((b) => b.keyframe && b.frame && b.frame.approved && b.frame.path);
  frames.forEach((b, i) => add({
    kind: "storyboard", path: b.frame.path, beatId: b.id, role: b.role,
    label: `storyboard ${i + 1} of ${frames.length} (${b.role})${b.desc && b.desc.trim() ? `: ${clip(b.desc, 100)}` : ""}`,
  }));
  refAssets(shot, ep).forEach((a) => add({
    kind: "asset", path: a.path, assetId: a.id, type: a.type,
    label: `${a.name}${a.angle ? ` — ${a.angle}` : ""} (${a.type})`, identityHold: usableHold(a.identityHold),
  }));
  const kept = out.slice(0, max).map((x, i) => ({ ...x, ref: `@Image${i + 1}` }));
  return { images: kept, dropped: out.length - kept.length };
}

export function resolveReferencePrompt(shot, ep, { videos = [], max } = {}) {
  const { images, dropped } = resolveReferenceSet(shot, ep, max ? { max } : undefined);
  const boards = images.filter((x) => x.kind === "storyboard");
  const assets = images.filter((x) => x.kind === "asset");
  const vids = videos.map((v, i) => ({ ...v, ref: `@Video${i + 1}` }));
  const lines = ["Reference images:"];
  images.forEach((x) => lines.push(`${x.ref} = ${x.label}`));
  if (vids.length) { lines.push("Reference videos:"); vids.forEach((v) => lines.push(`${v.ref} = ${v.label || "motion rehearsal"}`)); }
  const use = [];
  if (vids.length) use.push(`Follow ${vids.map((v) => v.ref).join(", ")} for camera movement, staging and timing only; take people, wardrobe, set and look from the images, never from the video.`);
  if (boards.length) use.push(`Use the storyboard frames (${boards.map((x) => x.ref).join(", ")}) as the key positions of this shot, in order — where people stand and how the action moves through the space. This is ONE continuous, unbroken take: move smoothly and gradually from each position to the next, with no cuts, jumps or skipped moments between them.`);
  if (assets.length) {
    use.push(`Use ${assets.map((x) => x.ref).join(", ")} as the absolute anchor for identity and setting; do not restyle or reinterpret them.`);
    const holds = assets.map((x) => x.identityHold).filter(Boolean);
    if (holds.length) use.push(holds.join(" "));
  }
  const base = resolveVideoPrompt(shot, ep); // asset map stripped: this block replaces it
  return {
    mode: base.mode, images, dropped, videos: vids,
    text: `${lines.join("\n")}${use.length ? `\n${use.join(" ")}` : ""}\n\n${base.text}`,
  };
}

// ---------- frames + references (H3 Max references) ----------
//
// The start/end storyboards go as the first/last frame (image_url /
// end_image_url, picked by resolveStartEndBeats), so the reference list holds
// only Identity Vault images: every angle of each referenced character (its
// turnaround AND face close-ups — Shawn's run 6 used both), then the other
// referenced assets (locations, props). Addressed as "Image 1…" (H3 wording).
export function resolveFramesRefSet(shot, ep, max = 9) {
  const assets = ep.assets || [];
  const direct = refAssets(shot, ep);
  const seen = new Set();
  const out = [];
  const add = (a) => { if (a.path && !seen.has(a.path)) { seen.add(a.path); out.push(a); } };
  // A character whose card is attached by its main image alone sends every angle of it
  // (turnaround and face close-ups). A shot that points at any OTHER image of the card
  // (a costume, say) sends exactly the images it picked.
  const chars = direct.filter((a) => a.type === "character");
  const done = new Set();
  for (const c of chars) {
    const key = cardKey(c);
    if (done.has(key)) continue;
    done.add(key);
    const card = assets.filter((a) => cardKey(a) === key);
    const picked = chars.filter((a) => cardKey(a) === key);
    const main = cardMain(card);
    if (picked.length === 1 && main && picked[0].id === main.id) card.forEach(add);
    else picked.forEach(add);
  }
  direct.filter((a) => a.type !== "character").forEach(add);
  const kept = out.slice(0, max).map((a, i) => ({
    kind: "asset", path: a.path, assetId: a.id, type: a.type, ref: `Image ${i + 1}`,
    label: `${a.name}${a.angle ? ` — ${a.angle}` : ""} (${a.type})`, identityHold: usableHold(a.identityHold),
  }));
  return { images: kept, dropped: out.length - kept.length };
}

export function resolveFramesRefPrompt(shot, ep, { max = 9, videos = [] } = {}) {
  // H3 Max takes at most 12 reference files in all: videos count against it.
  const { images, dropped } = resolveFramesRefSet(shot, ep, Math.min(max, 12 - videos.length));
  const { end } = resolveStartEndBeats(shot);
  const vids = videos.map((v, i) => ({ ...v, ref: `Video ${i + 1}` }));
  const head = [];
  if (images.length) {
    head.push(`${images.map((x) => `${x.ref} is ${x.label}`).join(". ")}.`);
    head.push("Keep every person and place consistent with their reference images; do not restyle them.");
    const holds = [...new Set(images.map((x) => x.identityHold).filter(Boolean))];
    if (holds.length) head.push(holds.join(" "));
  }
  if (vids.length) head.push(`${vids.map((v) => `${v.ref} is ${v.label || "a motion rehearsal"}`).join(". ")}. Follow ${vids.map((v) => v.ref).join(" and ")} for camera movement, staging and timing only; take people, wardrobe, set and look from the images, never from the video.`);
  head.push(end
    ? "The video opens exactly on the start image and ends exactly on the end image: one continuous shot, no cuts."
    : "The video opens exactly on the start image: one continuous shot, no cuts.");
  const base = resolveVideoPrompt(shot, ep, { style: "fal-brief" });
  return { mode: base.mode, images, dropped, videos: vids, text: `${head.join(" ")}\n\n${base.text}` };
}

// True when Shot direction has nothing to say but the camera line — no
// Action, no storyboard description on the keyframe beat. Generate then
// sends little more than "Camera: locked off." and the take drifts.
export function isThinDirection(shot) {
  const { start } = resolveStartEndBeats(shot);
  const beat = start || (shot.beats || []).find((b) => b.keyframe) || null;
  const hasAction = !!(shot.action && shot.action.trim());
  const hasDesc = !!(beat && beat.desc && beat.desc.trim() && beat.desc.trim() !== (shot.action || "").trim());
  return !hasAction && !hasDesc;
}

// `style` is the target model's rates.js promptStyle ("fal-brief" for H3 Max).
// A hand-edited prompt always wins, whatever the model.
export function autoDirection(shot, ep, style) {
  return style === "fal-brief" ? buildFalBrief(shot, ep) : buildDirection(shot, ep);
}

export function resolveVideoPrompt(shot, ep, { referencesSupported = false, style = null } = {}) {
  const mode = videoMode(shot);
  // Blocking joins the prompt only when the shot opts in (Shawn, 2026-10-12):
  // never automatic, or takes change without an obvious reason.
  const blk = shot.blockingInPrompt ? blockingSentence(shot.blocking) : "";
  const withBlk = (t) => (blk ? `${t}\n${blk}` : t);
  if (mode === "timecoded") {
    const full = (shot.timecodePrompt && shot.timecodePrompt.trim()) || draftTimecodeText(shot, ep);
    return { mode, text: withBlk(referencesSupported ? full : stripAssetMap(full).trim()) };
  }
  return { mode, text: withBlk((shot.videoPromptOverride && shot.videoPromptOverride.trim()) || autoDirection(shot, ep, style)) };
}

// ---------- exports for the desk ----------

// A hand-edited prompt wins over the auto-built one, everywhere — the box
// shown in the UI, and what Generate/Refine actually sends. Editing must
// never diverge from generating; these are the ONE place both paths resolve
// a beat's Nano/GPT prompt, so they can't drift apart.
export function resolveNano(shot, ep, beat) {
  return (beat && beat.nanoOverride && beat.nanoOverride.trim()) || buildNano(shot, ep, beat);
}
export function resolveGpt(shot, ep, beat) {
  return (beat && beat.gptOverride && beat.gptOverride.trim()) || buildGPT(shot, ep, beat);
}

export function shotPrompts(shot, ep, { style = null } = {}) {
  const beats = shot.beats || [];
  const { start: startBeat, end: endBeat } = resolveStartEndBeats(shot);
  return {
    frameBase: frameBaseName(shot),
    // The resolved (not just requested) start/end picks — auto-fallback
    // applied, so the client can highlight the actual winners without
    // re-deriving the fallback logic itself.
    videoStartBeatId: startBeat ? startBeat.id : null,
    videoEndBeatId: endBeat ? endBeat.id : null,
    // Only keyframe beats get a generated still. Timing-only beats appear in the
    // timecoded script and on the timeline, but cost nothing to produce.
    beats: beats.map((b, i) => ({
      id: b.id,
      role: b.role,
      keyframe: !!b.keyframe,
      frameName: b.keyframe ? beatFrameName(shot, b, i) : null,
      durationSec: beatDuration(b),
      nano: b.keyframe ? resolveNano(shot, ep, b) : null,
      gpt: b.keyframe ? resolveGpt(shot, ep, b) : null,
      nanoIsOverride: !!(b.nanoOverride && b.nanoOverride.trim()),
      gptIsOverride: !!(b.gptOverride && b.gptOverride.trim()),
    })),
    videoMode: videoMode(shot),
    direction: (shot.videoPromptOverride && shot.videoPromptOverride.trim()) || autoDirection(shot, ep, style),
    promptStyle: style,
    directionIsOverride: !!(shot.videoPromptOverride && shot.videoPromptOverride.trim()),
    directionThin: isThinDirection(shot),
    videoSent: resolveVideoPrompt(shot, ep, { style }).text,
    seedance: buildSeed(shot, ep),
    timecode: shot.timecodePrompt || draftTimecodeText(shot, ep),
    timecodeIsOverride: !!(shot.timecodePrompt && shot.timecodePrompt.trim()),
    durationSec: shotDuration(shot),
  };
}
