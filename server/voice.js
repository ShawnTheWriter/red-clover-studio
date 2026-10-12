// Character voices for the Dialogue lane. Shawn records each line himself;
// ElevenLabs speech-to-speech turns it into the character's voice, keeping his
// timing and delivery. The voiced file is a NEW recording beside his original
// (kind "voiced", same line), never a replacement — lip sync then uses it.

import fs from "node:fs/promises";
import path from "node:path";
import * as store from "./store.js";
import { probe } from "./ffprobe.js";
import { uid } from "../shared/schema.js";
import { ElevenLabsDriver, MockVoiceDriver, STS_MODEL } from "./drivers/elevenlabs.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const voiceDrivers = { elevenlabs: new ElevenLabsDriver(), mock: new MockVoiceDriver() };

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

// A character's voice lives on every angle of its card (one name, one voice).
export function voiceFor(ep, charId) {
  const a = (ep.assets || []).find((x) => x.id === charId);
  if (!a) return null;
  const withVoice = (ep.assets || []).find((x) => x.type === a.type && sameName(x.name, a.name) && x.elevenVoiceId);
  return withVoice ? { voiceId: withVoice.elevenVoiceId, voiceName: withVoice.elevenVoiceName || withVoice.elevenVoiceId, character: a.name } : { voiceId: null, voiceName: null, character: a.name };
}

export function setCharacterVoice(ep, assetId, { voiceId, voiceName }) {
  const a = (ep.assets || []).find((x) => x.id === assetId);
  if (!a) throw Object.assign(new Error("character not found"), { status: 404 });
  const group = ep.assets.filter((x) => x.type === a.type && sameName(x.name, a.name));
  for (const x of group) {
    if (voiceId) { x.elevenVoiceId = voiceId; x.elevenVoiceName = voiceName || voiceId; }
    else { delete x.elevenVoiceId; delete x.elevenVoiceName; }
  }
  return { character: a.name, voiceId: voiceId || null, voiceName: voiceName || null, angles: group.length };
}

const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);

// Voice a recording or a take's own audio: the shared tail of both routes.
// Calls the driver OUTSIDE the episode lock, then writes the clip under it.
async function voiceAudio(dir, { shotId, beat, audio, filename, driver, removeNoise, extra }) {
  const d = voiceDrivers[driver];
  const ep = await store.loadEpisode(dir);
  const shot = ep.shots.find((s) => s.id === shotId);
  const v = voiceFor(ep, beat.dialogue.charId);
  if (!v || !v.voiceId) throw Object.assign(new Error(`${v ? v.character : "This speaker"} has no ElevenLabs voice yet — choose one under Character voices`), { status: 400 });
  const out = await d.speechToSpeech({ audio, filename, voiceId: v.voiceId, removeBackgroundNoise: !!removeNoise });
  const ext = driver === "mock" ? path.extname(filename) : ".mp3";
  const code = `${shot.sceneNum}${shot.shotCode}`;
  const saved = await store.saveUpload({ relDir: dir, destSub: "05_delivery/audio/dialogue/voiced", filename: `${code}_${slug(v.character)}_${slug(v.voiceName)}${ext}`, buffer: out });
  const meta = await probe(store.absPath(saved));
  const seconds = Math.round(meta.durationSec * 100) / 100;
  return store.withEpisode(dir, (live) => {
    const s = live.shots.find((x) => x.id === shotId);
    if (!s) throw Object.assign(new Error("the shot was deleted while voicing; the file is kept at " + saved), { status: 409 });
    const voiced = {
      id: uid(), label: `${v.character} (${v.voiceName}): ${beat.dialogue.line.slice(0, 40)}`, path: saved, seconds,
      addedAt: new Date().toISOString(), beatId: beat.id, kind: "voiced", voiceId: v.voiceId, voiceName: v.voiceName, driver,
      ...extra,
    };
    s.audioClips = s.audioClips || [];
    s.audioClips.push(voiced);
    if (driver !== "mock") {
      live.ledger.entries.push({
        at: new Date().toISOString(), kind: "voice", driver, model: STS_MODEL, shotId, seconds,
        chargedUSD: 0, outcome: "done", note: `ElevenLabs credits (plan), voice ${v.voiceName}${extra.origin === "take" ? ", from the take's audio" : ""}`,
      });
    }
    return voiced;
  });
}

const driverReady = (driver) => {
  const d = voiceDrivers[driver];
  if (!d) throw Object.assign(new Error(`unknown voice driver "${driver}"`), { status: 400 });
  const st = d.status();
  if (!st.ready) throw Object.assign(new Error(st.reason), { status: 503 });
};

// Route A (Shawn, 2026-10-08): the take's delivery and mouth movement are
// good, only the voice is wrong. Pull the selected take's own audio (or a
// part of it, when one take holds two speakers), strip its background, and
// turn it into the character's voice. Speech-to-speech keeps the timing, so
// the result lines up with the picture: no lip sync. It is placed at the
// take's own time (offsetSec = where the extract starts in the take).
export async function revoiceFromTake(dir, { shotId, beatId, inSec = null, outSec = null, driver = "elevenlabs", removeNoise = true }) {
  driverReady(driver);
  const ep = await store.loadEpisode(dir);
  const shot = ep.shots.find((s) => s.id === shotId);
  if (!shot) throw Object.assign(new Error("shot not found"), { status: 404 });
  const beat = shot.beats.find((b) => b.id === beatId);
  if (!beat || !beat.dialogue || !beat.dialogue.line) throw Object.assign(new Error("line not found"), { status: 404 });
  const take = (shot.versions || []).find((v) => v.id === (shot.selectedVersions || [])[0] && v.state === "done" && v.path);
  if (!take) throw Object.assign(new Error("this shot has no selected take to take the audio from"), { status: 400 });
  const meta = await probe(store.absPath(take.path));
  if (!meta.hasAudio) throw Object.assign(new Error("the selected take has no audio track"), { status: 400 });
  const a = inSec == null || inSec === "" ? 0 : Number(inSec);
  const b = outSec == null || outSec === "" ? meta.durationSec : Number(outSec);
  if (!(Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b > a && a < meta.durationSec)) {
    throw Object.assign(new Error(`start/end must fit inside the take (0–${meta.durationSec.toFixed(2)} s), start before end`), { status: 400 });
  }
  const end = Math.min(b, meta.durationSec);
  const code = `${shot.sceneNum}${shot.shotCode}`;
  const extractRel = `${dir}/05_delivery/audio/dialogue/from-takes/${code}_${take.id}_${a.toFixed(2)}-${end.toFixed(2)}.wav`;
  await fs.mkdir(path.dirname(store.absPath(extractRel)), { recursive: true });
  await run("ffmpeg", ["-y", "-v", "error", "-ss", String(a), "-to", String(end), "-i", store.absPath(take.path), "-vn", "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", store.absPath(extractRel)], { timeout: 60000 });
  const audio = await fs.readFile(store.absPath(extractRel));
  return voiceAudio(dir, {
    shotId, beat, audio, filename: path.basename(extractRel), driver, removeNoise,
    extra: { origin: "take", sourceVersionId: take.id, offsetSec: Math.round(a * 1000) / 1000, extractedFrom: extractRel, importedFrom: `voiced from take ${take.id} (${a.toFixed(2)}–${end.toFixed(2)} s)` },
  });
}

// Voice one recording. The call happens OUTSIDE the episode lock (it can take
// several seconds); the result is written back under it.
export async function voiceLine(dir, { shotId, audioClipId, driver = "elevenlabs" }) {
  const d = voiceDrivers[driver];
  if (!d) throw Object.assign(new Error(`unknown voice driver "${driver}"`), { status: 400 });
  const st = d.status();
  if (!st.ready) throw Object.assign(new Error(st.reason), { status: 503 });

  const ep = await store.loadEpisode(dir);
  const shot = ep.shots.find((s) => s.id === shotId);
  const clip = shot && (shot.audioClips || []).find((c) => c.id === audioClipId);
  if (!clip) throw Object.assign(new Error("recording not found"), { status: 404 });
  if (clip.kind === "voiced") throw Object.assign(new Error("that recording is already a character voice — voice your original performance"), { status: 400 });
  const beat = clip.beatId ? shot.beats.find((b) => b.id === clip.beatId) : shot.beats.find((b) => b.dialogue && b.dialogue.line);
  if (!beat || !beat.dialogue) throw Object.assign(new Error("this recording isn't linked to a line — pick its line first"), { status: 400 });
  const v = voiceFor(ep, beat.dialogue.charId);
  if (!v || !v.voiceId) throw Object.assign(new Error(`${v ? v.character : "This speaker"} has no ElevenLabs voice yet — choose one under Character voices`), { status: 400 });

  const audio = await fs.readFile(store.absPath(clip.path));
  return voiceAudio(dir, {
    shotId, beat, audio, filename: path.basename(clip.path), driver, removeNoise: false,
    extra: { origin: "performance", sourceClipId: clip.id, importedFrom: `voiced from ${path.basename(clip.path)}` },
  });
}
