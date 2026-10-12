// Sound → SFX from picture (Shawn, 2026-10-08). A video-to-audio model watches
// the shot's selected take and makes sound in sync with its action. The test
// on shot 2a picked two models: Kling (cleanest; default) and Mirelo SFX 1.5
// (two variants per run — a fallback when Kling makes an artifact, like the
// squeak he heard). Every run is kept as a variant; one is "in edit".
//
// Stored on the shot (shot.sfx = { prompt, takes[], useId }). The sound is
// made from the WHOLE take, so it sits at the take's own time zero: the app
// timeline puts it on A2 (SFX), and "Add sound to my Resolve cut" anchors it
// to where that take plays in Shawn's edit.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as store from "./store.js";
import { probe } from "./ffprobe.js";
import { uid } from "../shared/schema.js";
import { defaultSfxPrompt } from "../shared/sound.js";
import { silentWav } from "./drivers/elevenlabs.js";

const run = promisify(execFile);

// Prices from fal's pricing API (2026-10-08). Mirelo bills per second and
// always returns at least 2 samples; whether each sample is billed is not
// documented, so the estimate counts both (errs high, the cap's safe side).
export const SFX_MODELS = {
  kling: { id: "kling", label: "Kling video-to-audio", endpoint: "fal-ai/kling-video/video-to-audio", minSec: 3, maxSec: 20, estimate: () => 0.035 },
  mirelo: { id: "mirelo", label: "Mirelo SFX 1.5 (2 variants)", endpoint: "mirelo-ai/sfx-v1.5/video-to-audio", minSec: 1, maxSec: 10, estimate: (sec) => Math.round(0.01 * Math.min(sec, 10) * 2 * 100) / 100 },
};

const takeOf = (shot) => (shot.versions || []).find((v) => v.id === (shot.selectedVersions || [])[0] && v.state === "done" && v.path);

export function setPrompt(ep, shotId, prompt) {
  const shot = ep.shots.find((s) => s.id === shotId);
  if (!shot) throw Object.assign(new Error("shot not found"), { status: 404 });
  shot.sfx = shot.sfx || { prompt: "", takes: [], useId: null };
  shot.sfx.prompt = String(prompt || "").trim();
  return shot.sfx;
}

export function useTake(ep, shotId, takeId) {
  const shot = ep.shots.find((s) => s.id === shotId);
  if (!shot || !shot.sfx) throw Object.assign(new Error("no SFX on this shot"), { status: 404 });
  if (takeId && !shot.sfx.takes.some((t) => t.id === takeId)) throw Object.assign(new Error("SFX variant not found"), { status: 404 });
  shot.sfx.useId = takeId || null;
  return shot.sfx;
}

export function promptFor(ep, shot) {
  const scene = (ep.scenes || []).find((s) => String(s.number) === String(shot.sceneNum));
  return (shot.sfx && shot.sfx.prompt) || defaultSfxPrompt(shot, scene);
}

// The price shown before a run is the price the cap checks.
export async function quoteSfx(ep, { shotId, model }) {
  const m = SFX_MODELS[model];
  if (!m) throw Object.assign(new Error(`unknown SFX model "${model}"`), { status: 400 });
  const shot = ep.shots.find((s) => s.id === shotId);
  if (!shot) throw Object.assign(new Error("shot not found"), { status: 404 });
  const take = takeOf(shot);
  if (!take) throw Object.assign(new Error("this shot has no selected take to make sound for"), { status: 400 });
  const meta = await probe(store.absPath(take.path));
  if (meta.durationSec < m.minSec) throw Object.assign(new Error(`${m.label} needs a take of at least ${m.minSec} s; this one is ${meta.durationSec.toFixed(1)} s`), { status: 400 });
  if (meta.durationSec > m.maxSec && model === "kling") throw Object.assign(new Error(`${m.label} takes at most ${m.maxSec} s`), { status: 400 });
  return { model: m.id, label: m.label, takeId: take.id, takePath: take.path, seconds: meta.durationSec, estimateUSD: m.estimate(meta.durationSec), note: model === "mirelo" && meta.durationSec > 10 ? "Mirelo covers the first 10 s only" : "" };
}

export async function generate(dir, { shotId, model = "kling", prompt, driver = "fal", confirmedUSD }, { drivers, ledgerState, enforceSpendGuards }) {
  const ep = await store.loadEpisode(dir);
  const shot = ep.shots.find((s) => s.id === shotId);
  const q = await quoteSfx(ep, { shotId, model });
  const text = String(prompt ?? promptFor(ep, shot)).trim();
  if (model === "kling" && text.length > 200) throw Object.assign(new Error(`Kling takes at most 200 characters; the prompt is ${text.length}`), { status: 400 });

  if (driver !== "mock") {
    const led = ledgerState(ep);
    enforceSpendGuards({
      totalUSD: q.estimateUSD, ledger: led,
      fitsInBudget: q.estimateUSD <= led.remainingUSD,
      needsConfirmation: q.estimateUSD > led.confirmAboveUSD,
    }, confirmedUSD);
  }

  const code = `${shot.sceneNum}${shot.shotCode}`;
  const outs = []; // [{ buf | url, ext }]
  let requestId = null;
  if (driver === "mock") {
    const n = model === "mirelo" ? 2 : 1;
    for (let i = 0; i < n; i++) outs.push({ buf: silentWav(Math.min(q.seconds, model === "mirelo" ? 10 : q.seconds)), ext: ".wav" });
  } else {
    const fal = drivers.fal;
    const st = fal.status();
    if (!st.ready) throw Object.assign(new Error(st.reason), { status: 503 });
    // A silent 720p copy: small upload, and the model hears none of the take's
    // own sound.
    const tmp = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "rcs-sfx-")), `${code}_silent.mp4`);
    await run("ffmpeg", ["-y", "-v", "error", "-i", store.absPath(q.takePath), "-an", "-vf", "scale=720:-2", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", tmp], { timeout: 120000 });
    const videoUrl = await fal.uploadFile(tmp);
    await fs.rm(path.dirname(tmp), { recursive: true, force: true }).catch(() => {});
    const input = model === "kling"
      ? { video_url: videoUrl, sound_effect_prompt: text, background_music_prompt: null, asmr_mode: false } // its defaults describe a car race
      : { video_url: videoUrl, text_prompt: text, duration: Math.min(10, Math.max(1, Math.round(q.seconds * 10) / 10)), num_samples: 2 };
    const r = await fal.runQueued(SFX_MODELS[model].endpoint, input);
    requestId = r.requestId;
    const urls = model === "kling" ? [r.result?.audio?.url] : (r.result?.audio || []).map((a) => a.url);
    for (const u of urls.filter(Boolean)) outs.push({ url: u, ext: path.extname(new URL(u).pathname) || ".mp3" });
    if (!outs.length) throw Object.assign(new Error(`${SFX_MODELS[model].label} finished but returned no audio`), { status: 502 });
  }

  const saved = [];
  for (let i = 0; i < outs.length; i++) {
    const o = outs[i];
    const rel = `${dir}/05_delivery/audio/sfx/${code}_${model}_${Date.now().toString(36)}_${i + 1}${o.ext}`;
    const abs = store.absPath(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    if (o.buf) await fs.writeFile(abs, o.buf);
    else await drivers.fal.download(o.url, abs);
    const meta = await probe(abs);
    saved.push({ path: rel, seconds: Math.round(meta.durationSec * 100) / 100 });
  }

  return store.withEpisode(dir, (live) => {
    const s = live.shots.find((x) => x.id === shotId);
    if (!s) throw Object.assign(new Error("the shot was deleted while generating; files kept in 05_delivery/audio/sfx"), { status: 409 });
    s.sfx = s.sfx || { prompt: "", takes: [], useId: null };
    s.sfx.prompt = text;
    const at = new Date().toISOString();
    const added = saved.map((f, i) => ({
      id: uid(), model, label: `${SFX_MODELS[model].label.replace(/ \(.*\)$/, "")}${saved.length > 1 ? ` ${String.fromCharCode(65 + i)}` : ""}`,
      path: f.path, seconds: f.seconds, sourceVersionId: q.takeId, prompt: text, driver, at, requestId,
    }));
    s.sfx.takes.push(...added);
    if (!s.sfx.useId) s.sfx.useId = added[0].id;
    if (driver !== "mock") {
      live.ledger = live.ledger || { budgetCapUSD: 25, confirmAboveUSD: 2, spentUSD: 0, entries: [] };
      live.ledger.spentUSD = Math.round(((live.ledger.spentUSD || 0) + q.estimateUSD) * 1000) / 1000; // Kling is $0.035: keep the half cent
      live.ledger.entries.push({ at, kind: "sfx", driver: "fal", model: SFX_MODELS[model].endpoint, shotId, seconds: q.seconds, estimateUSD: q.estimateUSD, actualUSD: null, chargedUSD: q.estimateUSD, outcome: "done", requestId });
    }
    return { shot: `${s.sceneNum}${s.shotCode}`, added, chargedUSD: driver === "mock" ? 0 : q.estimateUSD };
  });
}
