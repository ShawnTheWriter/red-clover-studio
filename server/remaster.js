// "Create Remaster project from XML": the proof-of-concept cut (cheap MiniMax
// takes, edited in Resolve) becomes the template for a higher-quality pass.
// Agreed with Shawn 2026-10-07:
// - A NEW episode folder beside the source ("<episode> - Remaster"), a replica
//   of the proof-of-concept workflow: same scenes, shots, storyboards,
//   prompts, refs, camera, assets — in cut order, with NO takes.
// - Only shots with picture in the cut come over. The rest are listed as
//   "left out" with Add back (they may return).
// - Each shot gets a target length: the source span it uses in the cut plus a
//   0.5 s handle at each end. Generation snaps it up to a length the chosen
//   model sells. Creating the project costs nothing.
// - Sound the cut uses without its picture (an audio-only shot, a take's
//   sound used as room tone) is listed as an audio need, not a shot.
// - The model choice belongs to generation time, not here.

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import * as store from "./store.js";
import * as cut from "./cut.js";
import { newEpisode, newLedger, newTimeline, renumberScene, uid } from "../shared/schema.js";
import { writeSceneBinScripts } from "./resolve-script.js";

// Shawn, 2026-10-08: the remaster is hybrid — H3 Max is the base model, and
// he switches single shots to Seedance 2.5 where they need it.
export const REMASTER_DEFAULT_VIDEO_MODEL = "minimax/h3-max/image-to-video";

export const HANDLES_SEC = 0.5;
const r2 = (n) => Math.round(n * 100) / 100;
const clone = (o) => JSON.parse(JSON.stringify(o));

export function planRemaster(ep, analysis, { handlesSec = HANDLES_SEC } = {}) {
  const byId = new Map((ep.shots || []).map((s) => [s.id, s]));
  // Array order is shot sequence and must keep scenes ascending (the app's
  // invariant); inside a scene, cut order.
  const sn = (n) => (Number.isNaN(Number(n)) ? Infinity : Number(n));
  const inCut = analysis.shots.filter((s) => s.status === "in").sort((a, b) => sn(a.sceneNum) - sn(b.sceneNum) || a.firstAt - b.firstAt);
  const shots = inCut.map((a) => {
    // One part per take used. 3a's two takes (a multi-shot clip with the
    // middle removed) add up to one shot's worth of action.
    const spanSec = r2(a.parts.reduce((t, p) => t + (p.srcOut - p.srcIn), 0));
    return {
      shotId: a.shotId, code: a.code, label: a.label, sceneNum: a.sceneNum,
      parts: a.parts.map((p) => ({ versionId: p.versionId, srcIn: p.srcIn, srcOut: p.srcOut })),
      spanSec, visibleSeconds: r2(a.visibleSeconds), targetSeconds: r2(spanSec + 2 * handlesSec),
    };
  });
  const leftOut = analysis.shots.filter((s) => s.status !== "in").map((s) => ({
    shotId: s.shotId, code: s.code, label: s.label, status: s.status,
  }));

  // Sound used away from its own picture: either the shot has no picture at
  // all (audio-only), or the sound sits at times its picture isn't on screen
  // (2v's rain as room tone). Sound under its own picture is just the take's
  // own audio and needs nothing.
  const audioNeeds = [];
  for (const a of analysis.shots) {
    if (!a.audioUses.length) continue;
    const pictureAt = a.parts.flatMap((p) => p.at);
    const away = a.audioUses.filter((u) => !pictureAt.some((r) => u.start < r.end - 0.05 && u.end > r.start + 0.05));
    if (!away.length) continue;
    audioNeeds.push({
      shotId: a.shotId, code: a.code, label: a.label,
      kind: a.status === "in" ? "sound-elsewhere" : "audio-only",
      uses: away.length,
      seconds: r2(away.reduce((t, u) => t + (u.end - u.start), 0)),
      from: r2(Math.min(...away.map((u) => u.start))),
      to: r2(Math.max(...away.map((u) => u.end))),
    });
  }

  // Storyboard files to copy: every frame path of every shot coming over.
  const frames = new Set();
  for (const s of shots) for (const b of byId.get(s.shotId)?.beats || []) if (b.frame?.path) frames.add(b.frame.path);

  return {
    handlesSec, shots, leftOut, audioNeeds,
    storyboards: frames.size,
    totalTargetSec: r2(shots.reduce((t, s) => t + s.targetSeconds, 0)),
    cutSeconds: analysis.sequence.duration,
  };
}

async function freeDir(base) {
  let n = 1, cand = base;
  while (await fs.access(store.safeResolve(cand)).then(() => true, () => false)) cand = `${base} ${++n}`;
  return cand;
}

// A copied shot: everything that defines it, none of its takes.
function emptyShot(src) {
  const s = clone(src);
  s.versions = [];
  s.selectedVersions = [];
  delete s.selectedVersion;
  delete s.cutFromEdit;
  s.videoModelId = ""; // the remaster's own default applies, not the source's pick
  s.takeTrims = {};    // trims belong to takes, and the remaster has none yet
  return s;
}

async function copyFrames(shot, srcDir, dstDir, copied) {
  for (const b of shot.beats || []) {
    const p = b.frame && b.frame.path;
    if (!p || path.isAbsolute(p) || !p.startsWith(`${srcDir}/`)) continue;
    const rel = path.posix.relative(srcDir, p);
    const to = `${dstDir}/${rel}`;
    if (!copied.has(p)) {
      const ok = await fs.access(store.safeResolve(p)).then(() => true, () => false);
      if (ok) {
        await fs.mkdir(path.dirname(store.safeResolve(to)), { recursive: true });
        await fs.copyFile(store.safeResolve(p), store.safeResolve(to));
        copied.set(p, to);
      } else {
        copied.set(p, p); // missing on disk: keep the old reference, don't invent
      }
    }
    b.frame.path = copied.get(p);
  }
}

export async function previewRemaster(dir, xmlPath) {
  const ep = await store.loadEpisode(dir);
  const analysis = cut.analyzeCut(ep, cut.parseCut(await cut.readCutFile(store.safeResolve(xmlPath))), store.ROOT);
  const plan = planRemaster(ep, analysis);
  const folder = await freeDir(`${dir} - Remaster`);
  return { xmlPath, folder, name: `${ep.name} — Remaster`, unmatched: analysis.unmatched, ambiguous: analysis.ambiguous, ...plan };
}

export async function createRemaster(dir, xmlPath) {
  const src = await store.loadEpisode(dir);
  if (src.remaster) throw Object.assign(new Error("This episode is itself a remaster. Make the remaster from the proof-of-concept episode."), { status: 400 });
  const analysis = cut.analyzeCut(src, cut.parseCut(await cut.readCutFile(store.safeResolve(xmlPath))), store.ROOT);
  if (analysis.unmatched.length || analysis.ambiguous.length) throw Object.assign(new Error("Some clips in the XML don't match a take. Fix that first."), { status: 409 });
  const plan = planRemaster(src, analysis);
  const folder = await freeDir(`${dir} - Remaster`);
  await store.scaffold(folder);

  const byId = new Map(src.shots.map((s) => [s.id, s]));
  const copied = new Map();
  const shots = [];
  for (const p of plan.shots) {
    const s = emptyShot(byId.get(p.shotId));
    await copyFrames(s, dir, folder, copied);
    s.remaster = { sourceCode: p.code, parts: p.parts, spanSec: p.spanSec, visibleSeconds: p.visibleSeconds, targetSeconds: p.targetSeconds, handlesSec: plan.handlesSec };
    shots.push(s);
  }
  // Letters are derived from position. A left-out shot leaves a gap, so the
  // remaster re-letters; the source code stays on shot.remaster.sourceCode.
  for (const n of new Set(shots.map((x) => x.sceneNum))) renumberScene(shots, n);

  const ep = newEpisode({
    seriesId: src.seriesId, number: src.number, name: `${src.name} — Remaster`, dir: folder,
    gate: src.gate, gateLog: [...(src.gateLog || []), { at: new Date().toISOString(), note: `Remaster created from ${dir} via ${path.basename(xmlPath)}` }],
    hook: src.hook, cliffhanger: src.cliffhanger, assetAuditOverrides: clone(src.assetAuditOverrides || {}),
    fmt: src.fmt, style: src.style, ban: src.ban, lean: src.lean, scriptPath: src.scriptPath,
    scenes: clone(src.scenes || []), assets: clone(src.assets || []), shots,
    timeline: newTimeline(), exports: [], ledger: newLedger(), jobs: [],
    defaultVideoModelId: REMASTER_DEFAULT_VIDEO_MODEL,
  });
  ep.remaster = {
    sourceDir: dir, xmlPath, createdAt: new Date().toISOString(), handlesSec: plan.handlesSec,
    cutSeconds: plan.cutSeconds, leftOut: plan.leftOut, audioNeeds: plan.audioNeeds,
  };
  await store.saveEpisode(folder, ep);
  const storyboardsCopied = [...copied].filter(([from, to]) => from !== to).length;
  // Its own bins script, ready for when its takes arrive.
  await writeSceneBinScripts(ep, store.ROOT, store.safeResolve(folder)).catch(() => {});
  return { folder, name: ep.name, shots: shots.length, storyboardsCopied, totalTargetSec: plan.totalTargetSec };
}

// Bring a left-out shot into the remaster, at its source position. It has no
// target length (it isn't in the cut); Shawn sets the duration by hand.
export async function addBack(dir, shotId) {
  return store.withEpisode(dir, async (ep) => {
    if (!ep.remaster) throw Object.assign(new Error("Not a remaster episode."), { status: 400 });
    const src = await store.loadEpisode(ep.remaster.sourceDir);
    const from = src.shots.find((s) => s.id === shotId);
    if (!from) throw Object.assign(new Error("That shot is no longer in the source episode."), { status: 404 });
    if (ep.shots.some((s) => s.id === shotId)) throw Object.assign(new Error("Already in the remaster."), { status: 400 });
    const s = emptyShot(from);
    if (s.sceneNum === "X") {
      const lo = ep.remaster.leftOut.find((l) => l.shotId === shotId);
      throw Object.assign(new Error(`${lo ? lo.code : "This shot"} is in the source's Cut from edit bin. Restore it to a scene there first.`), { status: 409 });
    }
    await copyFrames(s, ep.remaster.sourceDir, dir, new Map());
    s.remaster = { sourceCode: `${from.sceneNum}${from.shotCode}`, parts: [], spanSec: null, visibleSeconds: 0, targetSeconds: null, handlesSec: ep.remaster.handlesSec, addedBack: true };
    // Back where it sat in the source: right after the last shot of its scene
    // that came before it there (shot ids are shared), else first in its scene.
    const srcIdx = new Map(src.shots.map((x, i) => [x.id, i]));
    const mine = srcIdx.get(shotId);
    let at = -1;
    ep.shots.forEach((x, i) => { if (x.sceneNum === s.sceneNum && (srcIdx.get(x.id) ?? Infinity) < mine) at = i + 1; });
    if (at < 0) {
      const first = ep.shots.findIndex((x) => x.sceneNum === s.sceneNum);
      at = first >= 0 ? first : ep.shots.findIndex((x) => Number(x.sceneNum) > Number(s.sceneNum));
    }
    ep.shots.splice(at < 0 ? ep.shots.length : at, 0, s);
    renumberScene(ep.shots, s.sceneNum);
    ep.remaster.leftOut = ep.remaster.leftOut.filter((l) => l.shotId !== shotId);
    return { shotId, code: `${s.sceneNum}${s.shotCode}` };
  }, { history: true });
}

// ---------- the proof-of-concept take as a reference clip ----------
//
// Agreed 2026-10-12: each remastered shot can send the part of its old take
// that made the cut as a motion reference (camera, staging, timing). Listed
// on the shot, off by default; the trim is made only when switched on, into
// the remaster's 02_assets/reference_video/, never touching the source take.

const sameSpan = (a, b) => a && b && a.versionId === b.versionId && Math.abs(a.srcIn - b.srcIn) < 0.01 && Math.abs(a.srcOut - b.srcOut) < 0.01;

async function sourceTake(sourceDir, versionId) {
  const src = await store.loadEpisode(sourceDir).catch(() => null);
  if (!src) return null;
  for (const s of src.shots || []) {
    const v = (s.versions || []).find((x) => x.id === versionId);
    if (v) return { path: v.path, label: v.label || "", modelId: v.modelId || v.model || "", seconds: Number(v.seconds) || null };
  }
  return null;
}

export async function cutParts(dir, shotId) {
  const ep = await store.loadEpisode(dir);
  const shot = (ep.shots || []).find((s) => s.id === shotId);
  if (!shot) throw Object.assign(new Error("shot not found"), { status: 404 });
  if (!ep.remaster || !shot.remaster) return { remaster: false, parts: [] };
  const parts = [];
  for (const [index, p] of (shot.remaster.parts || []).entries()) {
    const t = await sourceTake(ep.remaster.sourceDir, p.versionId);
    const onDisk = !!(t && t.path && await fs.access(store.safeResolve(t.path)).then(() => true, () => false));
    const rv = (shot.refVideos || []).find((v) => sameSpan(v.fromCut, p));
    parts.push({
      index, versionId: p.versionId, srcIn: p.srcIn, srcOut: p.srcOut, seconds: r2(p.srcOut - p.srcIn),
      sourcePath: t ? t.path : null, onDisk, modelId: t ? t.modelId : "",
      refVideoId: rv ? rv.id : null, use: !!(rv && rv.use !== false),
    });
  }
  return { remaster: true, sourceCode: shot.remaster.sourceCode, addedBack: !!shot.remaster.addedBack, parts };
}

function ffmpegTrim(srcAbs, outAbs, inSec, outSec) {
  // Re-encoded so the cut is frame-accurate; no audio (it's a motion reference).
  const args = ["-hide_banner", "-loglevel", "error", "-ss", String(inSec), "-i", srcAbs, "-t", String(r2(outSec - inSec)),
    "-map", "0:v:0", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-n", outAbs];
  return new Promise((resolve, reject) => execFile("ffmpeg", args, (err, _o, stderr) => (err ? reject(Object.assign(new Error(`ffmpeg couldn't trim the take: ${String(stderr || err.message).trim().slice(0, 300)}`), { status: 500 })) : resolve())));
}

// Switch one part on or off. On: reuse the clip if it was made before,
// otherwise trim it now. Off: the clip stays on the shot, just not sent.
export async function useCutPart(dir, shotId, index, use, { probe } = {}) {
  const info = await cutParts(dir, shotId);
  const p = info.parts[index];
  if (!p) throw Object.assign(new Error("that part isn't in this shot's cut"), { status: 404 });
  let made = null;
  if (use && !p.refVideoId) {
    if (!p.onDisk) throw Object.assign(new Error("The proof-of-concept take isn't on disk any more."), { status: 409 });
    const rel = `${dir}/02_assets/reference_video`;
    await fs.mkdir(store.safeResolve(rel), { recursive: true });
    const base = `poc_${info.sourceCode || shotId}_${String(p.srcIn.toFixed(2)).replace(".", "-")}-${String(p.srcOut.toFixed(2)).replace(".", "-")}`;
    let name = `${base}.mp4`, n = 1;
    while (await fs.access(store.safeResolve(`${rel}/${name}`)).then(() => true, () => false)) name = `${base}_${++n}.mp4`;
    await ffmpegTrim(store.safeResolve(p.sourcePath), store.safeResolve(`${rel}/${name}`), p.srcIn, p.srcOut);
    made = { path: `${rel}/${name}`, seconds: p.seconds, width: null, height: null, fps: null };
    if (probe) { try { const pr = await probe(store.safeResolve(made.path)); made.seconds = pr.durationSec ?? made.seconds; made.width = pr.width ?? null; made.height = pr.height ?? null; made.fps = pr.fps ?? null; } catch { /* keep the cut's length */ } }
  }
  return store.withEpisode(dir, (ep) => {
    const shot = ep.shots.find((s) => s.id === shotId);
    shot.refVideos = shot.refVideos || [];
    let v = shot.refVideos.find((x) => sameSpan(x.fromCut, p));
    if (!v && made) {
      v = { id: uid(), ...made, label: `proof of concept ${info.sourceCode || ""} ${p.srcIn.toFixed(1)}–${p.srcOut.toFixed(1)} s`.replace(/\s+/g, " ").trim(),
        use: true, addedAt: new Date().toISOString(), fromCut: { versionId: p.versionId, srcIn: p.srcIn, srcOut: p.srcOut, sourceDir: ep.remaster.sourceDir } };
      shot.refVideos.push(v);
    }
    if (v) v.use = !!use;
    return { id: v ? v.id : null, use: !!(v && v.use), made: !!made, path: v ? v.path : null };
  }, { history: true });
}
