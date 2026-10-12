// Sound → Room tone (Shawn, 2026-10-07: "relatively trivial"; replaces the
// proof of concept's trick of looping take 2v's rain under three scenes).
// One row per scene: a prompt (prefilled from the slugline, his to edit), any
// number of generated loops, and the one "in edit". The timeline rebuild
// tiles that loop across the scene on its own track (A4, "Room tone").
//
// Stored on the scene record (scene.roomTone), so it follows the scene
// through renumbering, Organize and Create Remaster.

import * as store from "./store.js";
import { probe } from "./ffprobe.js";
import { uid } from "../shared/schema.js";
import { voiceDrivers } from "./voice.js";
import { SFX_MODEL } from "./drivers/elevenlabs.js";
import { defaultRoomTonePrompt } from "../shared/sound.js";

export const LOOP_MAX_SEC = 22; // ElevenLabs sound effects: 0.5–22 s

export const defaultPrompt = defaultRoomTonePrompt;

function sceneOf(ep, sceneNum) {
  const sc = (ep.scenes || []).find((s) => String(s.number) === String(sceneNum));
  if (!sc) throw Object.assign(new Error(`scene ${sceneNum} not found`), { status: 404 });
  return sc;
}

const ensure = (sc) => (sc.roomTone = sc.roomTone || { prompt: defaultPrompt(sc), takes: [], useId: null });

export function setPrompt(ep, sceneNum, prompt) {
  const rt = ensure(sceneOf(ep, sceneNum));
  rt.prompt = String(prompt || "").trim();
  return rt;
}

export function useTake(ep, sceneNum, takeId) {
  const rt = ensure(sceneOf(ep, sceneNum));
  if (takeId && !rt.takes.some((t) => t.id === takeId)) throw Object.assign(new Error("room tone take not found"), { status: 404 });
  rt.useId = takeId || null;
  return rt;
}

// Generate one loop. The call runs outside the episode lock; the take is
// written back under it.
export async function generate(dir, { sceneNum, prompt, seconds = 20, driver = "elevenlabs" }) {
  const d = voiceDrivers[driver];
  if (!d) throw Object.assign(new Error(`unknown sound driver "${driver}"`), { status: 400 });
  const st = d.status();
  if (!st.ready) throw Object.assign(new Error(st.reason), { status: 503 });
  const ep = await store.loadEpisode(dir);
  const sc = sceneOf(ep, sceneNum);
  const text = String(prompt ?? (sc.roomTone && sc.roomTone.prompt) ?? defaultPrompt(sc)).trim();
  const secs = Math.min(LOOP_MAX_SEC, Math.max(0.5, Number(seconds) || 20));
  const audio = await d.soundEffect({ text, seconds: secs, loop: true });
  const ext = driver === "mock" ? ".wav" : ".mp3";
  const saved = await store.saveUpload({ relDir: dir, destSub: "05_delivery/audio/roomtone", filename: `scene${sceneNum}_roomtone${ext}`, buffer: audio });
  const meta = await probe(store.absPath(saved));
  return store.withEpisode(dir, (live) => {
    const s = (live.scenes || []).find((x) => x.id === sc.id) || sceneOf(live, sceneNum);
    const rt = ensure(s);
    rt.prompt = text;
    const take = { id: uid(), path: saved, seconds: Math.round(meta.durationSec * 100) / 100, prompt: text, driver, at: new Date().toISOString() };
    rt.takes.push(take);
    if (!rt.useId) rt.useId = take.id; // the first loop is in the edit until Shawn picks another
    if (driver !== "mock") {
      live.ledger.entries.push({ at: take.at, kind: "sfx", driver, model: SFX_MODEL, seconds: take.seconds, chargedUSD: 0, outcome: "done", note: `ElevenLabs credits (plan), room tone scene ${s.number}` });
    }
    return { scene: s.number, take };
  });
}

// Timeline: tile each scene's in-edit loop across the scene's span on V1.
// A scene's span runs from its first shot's clip start to its last shot's
// clip end; the last copy is tail-trimmed to fit.
export function roomToneClips(ep, v1Clips, newClip) {
  const out = [];
  const shotScene = new Map((ep.shots || []).map((s) => [s.id, String(s.sceneNum)]));
  for (const sc of ep.scenes || []) {
    const rt = sc.roomTone;
    const take = rt && rt.useId && rt.takes.find((t) => t.id === rt.useId);
    if (!take || !(take.seconds > 0)) continue;
    const mine = v1Clips.filter((c) => shotScene.get(c.shotId) === String(sc.number));
    if (!mine.length) continue;
    const start = Math.min(...mine.map((c) => c.startSec));
    const end = Math.max(...mine.map((c) => c.startSec + c.durationSec));
    let at = start, n = 0;
    while (at < end - 1e-3 && n < 500) {
      const left = end - at;
      const tail = left < take.seconds ? take.seconds - left : 0;
      out.push(newClip({
        sourcePath: take.path, kind: "sfx", name: `Room tone — scene ${sc.number}${n ? ` (loop ${n + 1})` : ""}`,
        sourceDurationSec: take.seconds, headTrimSec: 0, tailTrimSec: Math.round(tail * 1000) / 1000, startSec: Math.round(at * 1000) / 1000,
        text: take.prompt,
      }));
      at += take.seconds; n++;
    }
  }
  return out;
}
