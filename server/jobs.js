// Job queue and cost ledger.
//
// Every generation goes through here, and nothing reaches a driver before the
// budget check passes. The plan's phrasing was "cost control is mandatory, not
// optional", so the enforcement lives on the submit path itself rather than in
// the UI, where a stray click or a second browser tab could route around it.
//
// Three guards, in order:
//   1. HARD CAP — estimated cost must fit in the episode's remaining budget.
//      Refused outright, no override available through the API.
//   2. CONFIRMATION — a batch over `confirmAboveUSD` needs an explicit confirm,
//      and the client must echo back the exact total it displayed. The server
//      recomputes and rejects a mismatch, so a UI that shows the wrong number
//      cannot get a larger spend approved than the one the human saw.
//   3. UNCALIBRATED WARNING — a model whose rate is a ceiling guess rather than
//      a measured figure is flagged so the estimate is never mistaken for a
//      quote. See server/rates.js for why those exist.

import path from "node:path";
import fs from "node:fs/promises";
import * as store from "./store.js";
import { estimateVideoUSD, videoModel, estimateImageUSD, imageModel, estimateLipsyncUSD, lipsyncModel, LIPSYNC_SYNC_MODES, modelShort, referenceUSD, refVideoUSD, cheapestRoute, upscaleModel, estimateUpscaleUSD, UPSCALE_TARGETS, finishModel, estimateFinishUSD, FINISH_MODELS } from "./rates.js";
import { probe } from "./ffprobe.js";
import { trimmedCopy, normalizeUpscaled } from "./upscale.js";
import { trimSpans, spansDuration, isWholeTake } from "../shared/trim.js";
import { readSettings } from "./settings.js";
import { FalDriver } from "./drivers/fal.js";
import { GeminiDriver } from "./drivers/gemini.js";
import { ReplicateDriver } from "./drivers/replicate.js";
import { AtlasDriver } from "./drivers/atlas.js";
import { SumeDriver } from "./drivers/sume.js";
import { ComfyDriver } from "./drivers/comfy.js";
import { MockDriver } from "./drivers/mock.js";
import { nearestSellable } from "../shared/schema.js";
import { resolveNano, refAssets, resolveVideoPrompt, resolveStartEndBeats, resolveReferencePrompt, resolveFramesRefPrompt, usableHold, refVideoSet } from "../shared/prompts.js";
import { beatFrameName } from "../shared/grammar.js";

const POLL_MS = 5000;
const CONCURRENCY = 3;
const TAKES_SUBDIR = "05_delivery/takes";

// "INT. Overlocks'S Hut" + "NIGHT" → "INT-Overlocks-Hut-Night". Possessive 's
// is dropped (the S1E1 slugs carry a stray capital S), words title-cased,
// cut at a word boundary so names stay short in Finder and Resolve.
export function slugForFile(shot) {
  if (!shot) return "";
  const word = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  const words = [shot.intext || "", shot.loc || "", shot.time || ""].join(" ")
    .replace(/['’]s\b/gi, "").replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const head = words.length && /^(INT|EXT|INSERT|INT\/EXT)$/i.test(words[0]) ? [words[0].toUpperCase()] : [];
  const rest = words.slice(head.length).map(word);
  let out = head.concat(rest);
  while (out.join("-").length > 32 && out.length > 1) out = out.slice(0, -1);
  return out.join("-");
}

// Shawn, 2026-10-08: a take's file says what it is in Finder —
// <shot code>_<slug>_<model code>_<version id>.mp4. The version id MUST stay
// last: the cut reader and Organize match a file to its take by it, and
// Organize rewrites only the leading shot code.
export function takeFileName(shot, version, ext = ".mp4") {
  const code = shot ? `${shot.sceneNum}${shot.shotCode}` : "take";
  const slug = slugForFile(shot);
  return `${code}_${slug ? `${slug}_` : ""}${modelShort(version.modelId, version.modelLabel)}_${version.id}${ext}`;
}

export const drivers = {
  fal: new FalDriver(),
  gemini: new GeminiDriver(),
  replicate: new ReplicateDriver(),
  atlas: new AtlasDriver(),
  sume: new SumeDriver(),
  comfy: new ComfyDriver(),
  mock: new MockDriver(),
};

export function driverStatus() {
  const out = {};
  for (const [name, d] of Object.entries(drivers)) out[name] = { name, ...d.status() };
  return out;
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const round2 = (n) => Math.round(n * 100) / 100;

// ---------- ledger ----------

export function ledgerState(ep) {
  const l = ep.ledger || { budgetCapUSD: 25, confirmAboveUSD: 2, spentUSD: 0, entries: [] };
  // Committed = everything already spent plus everything currently in flight.
  // In-flight work must count against the cap, or firing three fan-outs in
  // quick succession could each individually "fit" and collectively blow it.
  const inFlight = (ep.shots || []).flatMap((s) => s.versions || [])
    .filter((v) => v.state === "queued" || v.state === "running")
    .reduce((t, v) => t + (v.estimateUSD || 0), 0);
  const committed = (l.spentUSD || 0) + inFlight;
  return {
    budgetCapUSD: l.budgetCapUSD,
    confirmAboveUSD: l.confirmAboveUSD,
    spentUSD: round2(l.spentUSD || 0),
    inFlightUSD: round2(inFlight),
    committedUSD: round2(committed),
    remainingUSD: round2(Math.max(0, l.budgetCapUSD - committed)),
    entries: l.entries || [],
  };
}

// A correction to spend, added as its own visible entry. Old entries are never
// rewritten: they record what the app believed at the time, and the adjustment
// records what the provider's invoice later showed (2026-10-07: 33 MiniMax takes
// charged at a superseded rate). Positive raises spend, negative lowers it.
// No undo snapshot — like every other ledger write, undo must not touch money.
export async function recordAdjustment(dir, { amountUSD, note, source } = {}) {
  const amount = Number(amountUSD);
  if (!Number.isFinite(amount) || amount === 0) throw new Error("Adjustment needs a non-zero dollar amount.");
  if (!note || !String(note).trim()) throw new Error("Adjustment needs a note that says why.");
  return store.withEpisode(dir, (ep) => {
    ep.ledger = ep.ledger || { budgetCapUSD: 25, confirmAboveUSD: 2, spentUSD: 0, entries: [] };
    ep.ledger.entries = ep.ledger.entries || [];
    ep.ledger.spentUSD = round2((ep.ledger.spentUSD || 0) + amount);
    ep.ledger.entries.push({
      at: new Date().toISOString(),
      kind: "adjustment",
      chargedUSD: round2(amount),
      note: String(note).trim(),
      source: source ? String(source) : null,
      outcome: "done",
    });
    return ledgerState(ep);
  });
}

// A Claude call (server/llm.js): cost from the response's own token usage, so
// it is an actual, not an estimate. Kept to 4 decimals — a Haiku call can cost
// a tenth of a cent. No undo snapshot (money).
export async function recordLlmCharge(dir, { task, model, usd, usage, shotId = null, driver = "anthropic" } = {}) {
  const amount = Number(usd) || 0;
  const r4 = (n) => Math.round(n * 10000) / 10000;
  return store.withEpisode(dir, (ep) => {
    ep.ledger = ep.ledger || { budgetCapUSD: 25, confirmAboveUSD: 2, spentUSD: 0, entries: [] };
    ep.ledger.entries = ep.ledger.entries || [];
    ep.ledger.spentUSD = r4((ep.ledger.spentUSD || 0) + amount);
    ep.ledger.entries.push({
      at: new Date().toISOString(),
      kind: "llm",
      driver,
      ...(shotId ? { shotId } : {}),
      model: model || null,
      note: task || "",
      chargedUSD: r4(amount),
      actualUSD: r4(amount),
      tokens: usage ? { in: usage.input_tokens || 0, out: usage.output_tokens || 0, cacheWrite: usage.cache_creation_input_tokens || 0, cacheRead: usage.cache_read_input_tokens || 0 } : null,
      outcome: "done",
    });
    return ledgerState(ep);
  });
}

// Resolve the duration a clip will actually be BILLED for. A model sells whole
// takes from its own duration list, so a request for 6s on a [5, 10] model is
// billed as a 10s take — pricing the 6 under-reserves the cap on every clip. A
// non-positive or non-numeric duration is refused outright: a negative one
// priced a batch at a negative total, which satisfied the cap and skipped the
// confirmation threshold.
export function billableSeconds(modelId, seconds) {
  const m = videoModel(modelId);
  const allowed = m && m.durations && m.durations.length
    ? [...m.durations].sort((a, b) => a - b)
    : null;
  if (seconds == null) return allowed ? allowed[0] : (m ? m.minDuration : 5);
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) {
    throw Object.assign(
      new Error(`invalid duration ${JSON.stringify(seconds)} — must be a positive number of seconds`),
      { status: 400 },
    );
  }
  if (!allowed) return n;
  const take = allowed.find((d) => d >= n);
  if (take == null) {
    throw Object.assign(
      new Error(`${m.label} has no take as long as ${n}s — it offers ${allowed.join("s, ")}s`),
      { status: 400 },
    );
  }
  return take;
}

// Price a fan-out without committing to it. This is what the UI shows and what
// the human confirms, so it must be computed by exactly the same code the
// submit path uses to check the cap.
// Cheapest route is on unless the creator switched it off (settings.json
// "cheapestRoute": false). A service counts only if its driver is ready.
export const cheapestRouteOn = () => readSettings().cheapestRoute !== false;
const routeReady = (via) => { const d = drivers[via]; return !!d && d.status().ready; };

export function quote(ep, { shotIds, modelIds, seconds, route = cheapestRouteOn() }) {
  const lines = [];
  let routedSavingUSD = 0;
  for (const shotId of shotIds) {
    // "target": each shot's own length from the Resolve cut (remaster
    // episodes), snapped up to a length the model sells like any request.
    let want = seconds;
    if (seconds === "target") {
      const shot = (ep.shots || []).find((s) => s.id === shotId);
      want = shot && shot.remaster && shot.remaster.targetSeconds;
      if (!want) {
        const code = shot ? `${shot.sceneNum}${shot.shotCode}` : shotId;
        throw Object.assign(new Error(`${code} has no target length from the cut — pick a duration for it by hand`), { status: 400 });
      }
    }
    for (const pickedId of modelIds) {
      // The pick can be sold cheaper by another connected service.
      const rt = route ? cheapestRoute(pickedId, routeReady) : { modelId: pickedId, routed: false };
      const modelId = rt.modelId;
      const m = videoModel(modelId);
      // A target from the cut goes to the model's nearest sellable length.
      const secs = billableSeconds(modelId, seconds === "target" && m ? nearestSellable(m.durations, want) : want);
      const est = estimateVideoUSD(modelId, secs);
      // H3 Max references: the shot's reference images add a token charge,
      // costed as if each were 1280x720 (they are sent at <=1280 px).
      let refUSD = 0;
      const qshot = (ep.shots || []).find((s) => s.id === shotId);
      const qvids = qshot && m && m.refVideo ? refVideoSet(qshot, m.refVideo) : { videos: [], seconds: 0 };
      if (m && m.inputMode === "frames+refs" && qshot) {
        refUSD = referenceUSD(modelId, resolveFramesRefPrompt(qshot, ep, { max: m.maxRefs || 9, videos: qvids.videos }).images.map(() => ({})));
      }
      // Reference videos switched on for this shot, if the model takes them.
      refUSD += refVideoUSD(modelId, qvids.seconds);
      lines.push({
        shotId,
        modelId,
        modelLabel: m ? m.label : modelId,
        seconds: secs,
        estimateUSD: round2(est.usd + refUSD),
        // Sume publishes exact prices, so its live (promo-aware) price is a quote, not a guess.
        confidence: est.confidence === "live" && m && m.driver === "sume" ? "exact" : est.confidence,
        rate: est.rate,
        ...(rt.routed ? (() => {
          const was = estimateVideoUSD(pickedId, secs);
          routedSavingUSD += Math.max(0, was.usd - est.usd);
          return { routedFrom: pickedId, routedFromLabel: (videoModel(pickedId) || {}).label || pickedId, pickedRate: was.rate };
        })() : {}),
      });
    }
  }
  const totalUSD = round2(lines.reduce((t, l) => t + l.estimateUSD, 0));
  const uncalibrated = [...new Set(lines.filter((l) => l.confidence !== "exact" && l.confidence !== "measured").map((l) => l.modelLabel))];
  const led = ledgerState(ep);
  return {
    lines,
    totalUSD,
    clips: lines.length,
    cheapestRoute: !!route,
    routedSavingUSD: round2(routedSavingUSD),
    uncalibrated,
    ledger: led,
    fitsInBudget: totalUSD <= led.remainingUSD,
    needsConfirmation: totalUSD > led.confirmAboveUSD,
  };
}

class BudgetError extends Error {
  constructor(message, detail) { super(message); this.status = 402; this.detail = detail; }
}

// ---------- queue ----------

const running = new Set();   // version ids currently being polled
const pending = [];          // [{ dir, versionId }]
const cancelled = new Set(); // versions the user cancelled while their poll loop was live

export async function submitFanOut(dir, opts) {
  // The whole check-and-commit runs under the episode write lock. Quoting,
  // testing the cap and reserving the spend must be one atomic step: two
  // fan-outs submitted a moment apart could otherwise both read a budget with
  // room, both pass, and collectively overspend it.
  const { created, q } = await store.withEpisode(dir, (ep) => commitFanOut(ep, opts));
  for (const v of created) {
    if (v.state === "queued") pending.push({ dir, versionId: v.id, shotId: v.shotId });
  }
  pump();
  return { quote: q, versions: created };
}

// The two spend guards every paid submit passes through, whatever it buys:
// the hard cap, then the confirm-above-threshold with the displayed total
// echoed back. `q` only needs { totalUSD, fitsInBudget, needsConfirmation,
// ledger } — fan-outs and lip-sync quotes both provide them.
export function enforceSpendGuards(q, confirmedUSD) {
  // Guard 1: hard cap.
  if (!q.fitsInBudget) {
    throw new BudgetError(
      `Refused: estimated $${q.totalUSD.toFixed(2)} exceeds the $${q.ledger.remainingUSD.toFixed(2)} left of this episode's $${q.ledger.budgetCapUSD.toFixed(2)} cap.`,
      { quote: q },
    );
  }

  // Guard 2: confirmation, with the displayed total echoed back.
  if (q.needsConfirmation) {
    if (confirmedUSD == null) {
      throw new BudgetError(
        `Confirmation required: $${q.totalUSD.toFixed(2)} is over the $${q.ledger.confirmAboveUSD.toFixed(2)} threshold.`,
        { quote: q, needsConfirmation: true },
      );
    }
    // Number.isFinite FIRST. NaN fails every comparison, so a confirmation that
    // doesn't coerce to a number ("yes", {}, an empty object) sailed through the
    // mismatch test below and approved a spend nobody had echoed back.
    const confirmed = Number(confirmedUSD);
    if (!Number.isFinite(confirmed) || Math.abs(confirmed - q.totalUSD) > 0.01) {
      const shown = Number.isFinite(confirmed) ? `$${confirmed.toFixed(2)}` : JSON.stringify(confirmedUSD);
      throw new BudgetError(
        `Refused: confirmed ${shown} but the batch actually prices at $${q.totalUSD.toFixed(2)}. Re-check and confirm the real figure.`,
        { quote: q },
      );
    }
  }
}

// Which service runs a model: the row's own driver (Atlas rows say "atlas"),
// else what the caller asked for (fal). A mock rehearsal stays a mock.
export function driverForModel(modelId, requested = "fal") {
  if (requested === "mock") return "mock";
  return (videoModel(modelId) || {}).driver || requested;
}

function commitFanOut(ep, { shotIds, modelIds, seconds, driver: requested = "fal", confirmedUSD, audio }) {
  const q = quote(ep, { shotIds, modelIds, seconds });

  enforceSpendGuards(q, confirmedUSD);

  // Every service the batch needs must be ready before anything is created.
  for (const name of new Set(q.lines.map((l) => driverForModel(l.modelId, requested)))) {
    const d = drivers[name];
    if (!d) throw new Error(`unknown driver "${name}"`);
    const st = d.status();
    if (!st.ready) throw Object.assign(new Error(`driver "${name}" not ready: ${st.reason}`), { status: 503 });
  }

  // Create version records up front, all in one save, so the cap accounting
  // sees the whole batch as in-flight immediately.
  const created = [];
  for (const line of q.lines) {
    const shot = (ep.shots || []).find((s) => s.id === line.shotId);
    if (!shot) continue;
    // resolveStartEndBeats is the ONE place (shared with the storyboard
    // picker and the video pane) that decides which two approved keyframes
    // win — a shot can carry several purely to compare combos (Shawn's
    // startBeatId/endBeatId override), but only these two ever reach a model.
    const { start, end } = resolveStartEndBeats(shot);
    const keyframe = start ? start.frame : null;
    // How many images this model actually takes (checked against each
    // model's live fal schema 2026-09-25 — see rates.js).
    const vm = videoModel(line.modelId) || {};
    const slots = vm.imageParams?.length || 1;
    const endFrame = slots >= 2 && end ? end.frame : null;
    // A reference model takes the whole set (every approved storyboard + the
    // shot's assets), not start/end. The set AND its @Image-numbered prompt are
    // frozen onto the take here: numbering and images must never drift apart,
    // even if the shot is edited while this sits in the queue.
    const vids = vm.refVideo ? refVideoSet(shot, vm.refVideo).videos : [];
    const refSet = vm.inputMode === "reference" ? resolveReferencePrompt(shot, ep, { videos: vids, max: vm.maxRefs })
      : vm.inputMode === "frames+refs" ? resolveFramesRefPrompt(shot, ep, { max: vm.maxRefs || 9, videos: vids })
      : null;
    const moveChosen = !!(shot.move && String(shot.move).trim());
    const blocked = !keyframe
      ? "no approved keyframe still on this shot — board it first"
      : !moveChosen
      ? "no camera move chosen for this shot — pick one before generating"
      : null;
    const driver = driverForModel(line.modelId, requested);
    // The mock driver exists to rehearse this machinery without paying for it,
    // and the console labels it "no spend". It was still carrying a real estimate
    // into the ledger, so eight rehearsals exhausted a $25 cap and blocked the
    // first real fan-out.
    const billable = drivers[driver].billable !== false;
    const version = {
      id: uid(),
      shotId: shot.id,
      modelId: line.modelId,
      modelLabel: line.modelLabel,
      driver,
      ...(line.routedFrom ? { routedFrom: line.routedFrom } : {}),
      // Sound off, only on models that have the switch (same price either way).
      ...(audio === false && vm.audioSwitch ? { audio: false } : {}),
      seconds: line.seconds,
      keyframePath: keyframe ? keyframe.path : null,
      endKeyframePath: endFrame ? endFrame.path : null,
      ...(refSet ? {
        referencePaths: refSet.images.map((x) => x.path),
        referenceLabels: refSet.images.map((x) => ({ ref: x.ref, label: x.label })),
        referencePrompt: refSet.text,
        ...(refSet.videos && refSet.videos.length ? {
          referenceVideoPaths: refSet.videos.map((v) => v.path),
          referenceVideoLabels: refSet.videos.map((v) => ({ ref: v.ref, label: v.label || "" })),
        } : {}),
      } : {}),
      billable,
      estimateUSD: billable ? line.estimateUSD : 0,
      quotedUSD: line.estimateUSD,
      estimateConfidence: line.confidence,
      actualUSD: null,
      state: blocked ? "error" : "queued",
      error: blocked,
      jobId: null,
      path: null,
      submittedAt: new Date().toISOString(),
      finishedAt: null,
      elapsedMs: null,
    };
    shot.versions = shot.versions || [];
    shot.versions.push(version);
    created.push(version);
  }
  return { created, q };
}


// ---------- lip sync (a take made from a take) ----------
//
// A lip-sync run takes an EXISTING done take plus a recorded audio clip and
// produces a NEW take: same shot, `op: "lipsync"`, pointing back at its source.
// It goes through the same queue, ledger and spend guards as a generated clip —
// it costs real money, so it is a paid take for Undo purposes too (a fal-driven
// version is never rolled back), and it is never auto-selected: Shawn chooses
// it in the tray once he has watched it.

function findTake(ep, versionId) {
  for (const shot of ep.shots || []) {
    const take = (shot.versions || []).find((v) => v.id === versionId);
    if (take) return { shot, take };
  }
  return null;
}

function lipsyncInputs(ep, { versionId, audioClipId, modelId, syncMode }) {
  const hit = findTake(ep, versionId);
  if (!hit) throw Object.assign(new Error("take not found"), { status: 404 });
  const { shot, take } = hit;
  if (take.state !== "done" || !take.path) {
    throw Object.assign(new Error("that take hasn't finished — lip sync needs a finished video to work from"), { status: 400 });
  }
  const clip = (shot.audioClips || []).find((c) => c.id === audioClipId);
  if (!clip || !clip.path) throw Object.assign(new Error("audio clip not found on this take's shot"), { status: 404 });
  const model = lipsyncModel(modelId);
  if (!model) throw Object.assign(new Error(`unknown lip-sync model "${modelId}"`), { status: 400 });
  if (syncMode != null && !LIPSYNC_SYNC_MODES.includes(syncMode)) {
    throw Object.assign(new Error(`sync mode must be one of ${LIPSYNC_SYNC_MODES.join(", ")}`), { status: 400 });
  }
  // Billed on the source take's measured length. seconds isn't uniformly a
  // number across drivers (imports store a string), so coerce and verify.
  const seconds = Number(take.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw Object.assign(new Error("this take has no usable duration to price a lip sync against"), { status: 400 });
  }
  return { shot, take, clip, model, seconds };
}

export function quoteLipsync(ep, opts) {
  const { take, clip, model, seconds } = lipsyncInputs(ep, opts);
  const est = estimateLipsyncUSD(model.id, seconds);
  const totalUSD = round2(est.usd);
  const led = ledgerState(ep);
  return {
    versionId: take.id, audioClipId: clip.id, modelId: model.id, modelLabel: model.label,
    seconds, totalUSD, estimateUSD: totalUSD, confidence: est.confidence, rate: est.rate,
    ledger: led,
    fitsInBudget: totalUSD <= led.remainingUSD,
    needsConfirmation: totalUSD > led.confirmAboveUSD,
  };
}

function commitLipsync(ep, opts) {
  const { driver = "fal", syncMode, confirmedUSD } = opts;
  const { shot, take, clip, model, seconds } = lipsyncInputs(ep, opts);
  const q = quoteLipsync(ep, opts);
  enforceSpendGuards(q, confirmedUSD);

  const d = drivers[driver];
  if (!d) throw new Error(`unknown driver "${driver}"`);
  const st = d.status();
  if (!st.ready) throw Object.assign(new Error(`driver "${driver}" not ready: ${st.reason}`), { status: 503 });
  const billable = d.billable !== false;

  const version = {
    id: uid(),
    shotId: shot.id,
    op: "lipsync",
    sourceVersionId: take.id,
    sourcePath: take.path,          // survives the source take being deleted mid-run
    audioClipId: clip.id,
    audioPath: clip.path,           // survives Undo removing the audio clip record
    audioLabel: clip.label || "",
    syncMode: syncMode || "cut_off",
    modelId: model.id,
    modelLabel: `Lip sync (${model.label}) — ${take.modelLabel || "take"}`,
    driver,
    seconds,
    keyframePath: null,
    billable,
    estimateUSD: billable ? q.estimateUSD : 0,
    quotedUSD: q.estimateUSD,
    estimateConfidence: q.confidence,
    actualUSD: null,
    state: "queued",
    error: null,
    jobId: null,
    path: null,
    submittedAt: new Date().toISOString(),
    finishedAt: null,
    elapsedMs: null,
  };
  shot.versions = shot.versions || [];
  shot.versions.push(version);
  return { version, q };
}

export async function submitLipsync(dir, opts) {
  // Same atomic check-and-commit as a fan-out: quote, cap test and reservation
  // under one episode write lock.
  const { version, q } = await store.withEpisode(dir, (ep) => commitLipsync(ep, opts));
  pending.push({ dir, versionId: version.id, shotId: version.shotId });
  pump();
  return { quote: q, version };
}

// ---------- finish a draft (a take made from a take) ----------
//
// An Atlas Seedance 2.5 draft (480p) can be finished at 1080p within 7 days:
// the final inherits the draft's prompt, images, duration, ratio, seed and
// sound, so only the draft's id is sent. A NEW take (op "finish"), through the
// same queue, ledger and spend guards; never auto-selected. The quote shows the
// finish price, what the draft already cost, and the days left.

function finishInputs(ep, { versionId, modelId = FINISH_MODELS[0].id }) {
  const hit = findTake(ep, versionId);
  if (!hit) throw Object.assign(new Error("take not found"), { status: 404 });
  const { shot, take } = hit;
  if (take.state !== "done" || !take.path) throw Object.assign(new Error("that take hasn't finished"), { status: 400 });
  const row = videoModel(take.modelId) || {};
  if (!take.draftId || !row.draft) throw Object.assign(new Error("only an Atlas 480p draft can be finished at 1080p"), { status: 400 });
  const model = finishModel(modelId);
  if (!model) throw Object.assign(new Error(`unknown finish model "${modelId}"`), { status: 400 });
  // A free rehearsal (mock driver) finishes as a rehearsal; a real draft only where it was made.
  if (model.driver !== take.driver && take.driver !== "mock") throw Object.assign(new Error(`that draft was made on ${take.driver}; it can only be finished there`), { status: 400 });
  const expires = take.draftExpiresAt ? Date.parse(take.draftExpiresAt) : NaN;
  if (Number.isFinite(expires) && Date.now() > expires) {
    throw Object.assign(new Error(`this draft stopped being finishable on ${take.draftExpiresAt.slice(0, 10)} (7 days after it was made). Run it again as a draft.`), { status: 400 });
  }
  const seconds = Number(take.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) throw Object.assign(new Error("this draft has no usable duration to price a finish against"), { status: 400 });
  return { shot, take, model, seconds, expires: Number.isFinite(expires) ? take.draftExpiresAt : null };
}

export function quoteFinish(ep, opts) {
  const { take, model, seconds, expires } = finishInputs(ep, opts);
  const est = estimateFinishUSD(model.id, seconds);
  const totalUSD = round2(est.usd);
  const draftUSD = round2(take.actualUSD != null ? take.actualUSD : (take.estimateUSD || 0));
  const led = ledgerState(ep);
  return {
    versionId: take.id, modelId: model.id, modelLabel: model.label, target: model.target,
    seconds, totalUSD, estimateUSD: totalUSD, confidence: est.confidence, rate: est.rate,
    draftUSD, bothUSD: round2(draftUSD + totalUSD), expiresAt: expires,
    daysLeft: expires ? Math.max(0, Math.ceil((Date.parse(expires) - Date.now()) / 864e5)) : null,
    ledger: led,
    fitsInBudget: totalUSD <= led.remainingUSD,
    needsConfirmation: totalUSD > led.confirmAboveUSD,
  };
}

function commitFinish(ep, opts) {
  const { confirmedUSD } = opts;
  const { shot, take, model, seconds } = finishInputs(ep, opts);
  const driver = take.driver === "mock" ? "mock" : (opts.driver || "atlas");
  const q = quoteFinish(ep, opts);
  enforceSpendGuards(q, confirmedUSD);
  const d = drivers[driver];
  if (!d) throw new Error(`unknown driver "${driver}"`);
  const st = d.status();
  if (!st.ready) throw Object.assign(new Error(`driver "${driver}" not ready: ${st.reason}`), { status: 503 });
  const billable = d.billable !== false;
  const version = {
    id: uid(),
    shotId: shot.id,
    op: "finish",
    sourceVersionId: take.id,
    sourcePath: take.path,
    draftId: take.draftId,
    target: model.target,
    modelId: model.id,
    modelLabel: `Finish ${model.target} (Atlas) — ${take.modelLabel || "draft"}`,
    driver,
    seconds,
    prompt: take.prompt || null,    // inherited from the draft; shown under "Prompt sent"
    keyframePath: null,
    billable,
    estimateUSD: billable ? q.estimateUSD : 0,
    quotedUSD: q.estimateUSD,
    estimateConfidence: q.confidence,
    actualUSD: null,
    state: "queued",
    error: null,
    jobId: null,
    path: null,
    submittedAt: new Date().toISOString(),
    finishedAt: null,
    elapsedMs: null,
  };
  shot.versions = shot.versions || [];
  shot.versions.push(version);
  return { version, q };
}

export async function submitFinish(dir, opts) {
  const { version, q } = await store.withEpisode(dir, (ep) => commitFinish(ep, opts));
  pending.push({ dir, versionId: version.id, shotId: version.shotId });
  pump();
  return { quote: q, version };
}

// ---------- upscale (a take made from a take) ----------
//
// Same shape as lip sync: an EXISTING done take in, a NEW take out, `op:
// "upscale"`, never auto-selected, a paid take for Undo purposes. Priced on the
// seconds actually sent: when the take has a trim (the part used in the cut)
// only that span is cut out and upscaled, so the unused seconds cost nothing.

function upscaleInputs(ep, { versionId, modelId, target = "1080p", useTrim = true }) {
  const hit = findTake(ep, versionId);
  if (!hit) throw Object.assign(new Error("take not found"), { status: 404 });
  const { shot, take } = hit;
  if (take.state !== "done" || !take.path) {
    throw Object.assign(new Error("that take hasn't finished — upscaling needs a finished video"), { status: 400 });
  }
  const model = upscaleModel(modelId);
  if (!model) throw Object.assign(new Error(`unknown upscale model "${modelId}"`), { status: 400 });
  if (!UPSCALE_TARGETS.includes(target)) {
    throw Object.assign(new Error(`upscale target must be one of ${UPSCALE_TARGETS.join(", ")}`), { status: 400 });
  }
  const full = Number(take.seconds);
  if (!Number.isFinite(full) || full <= 0) {
    throw Object.assign(new Error("this take has no usable duration to price an upscale against"), { status: 400 });
  }
  // Only the kept pieces are sent (and paid for): the take's in/out minus its
  // cut-outs. spans = null means the whole take.
  let spans = null;
  let seconds = full;
  const t = shot.takeTrims && shot.takeTrims[take.id];
  if (useTrim && t) {
    const kept = trimSpans(t, full);
    if (!kept.length) throw Object.assign(new Error("this take's marks leave no video to upscale"), { status: 400 });
    if (!isWholeTake(kept, full)) { spans = kept; seconds = spansDuration(kept); }
  }
  return { shot, take, model, target, spans, seconds, fps: Number(take.fps) || 24 };
}

export function quoteUpscale(ep, opts) {
  const { take, model, target, spans, seconds, fps } = upscaleInputs(ep, opts);
  const est = estimateUpscaleUSD(model.id, { seconds, fps, target });
  const totalUSD = round2(est.usd);
  const led = ledgerState(ep);
  return {
    versionId: take.id, modelId: model.id, modelLabel: model.label, target, spans,
    seconds: Math.round(seconds * 100) / 100, fullSeconds: Number(take.seconds),
    totalUSD, estimateUSD: totalUSD, confidence: est.confidence, rate: est.rate,
    ledger: led,
    fitsInBudget: totalUSD <= led.remainingUSD,
    needsConfirmation: totalUSD > led.confirmAboveUSD,
  };
}

function commitUpscale(ep, opts) {
  const { driver = "fal", confirmedUSD } = opts;
  const { shot, take, model, target, spans, seconds } = upscaleInputs(ep, opts);
  const q = quoteUpscale(ep, opts);
  enforceSpendGuards(q, confirmedUSD);

  const d = drivers[driver];
  if (!d) throw new Error(`unknown driver "${driver}"`);
  const st = d.status();
  if (!st.ready) throw Object.assign(new Error(`driver "${driver}" not ready: ${st.reason}`), { status: 503 });
  const billable = d.billable !== false;

  const version = {
    id: uid(),
    shotId: shot.id,
    op: "upscale",
    sourceVersionId: take.id,
    sourcePath: take.path,          // survives the source take being deleted mid-run
    spans,                          // the kept pieces [{ inSec, outSec }]; null = the whole take
    target,
    modelId: model.id,
    modelLabel: `Upscale ${target} (${model.label}) — ${take.modelLabel || "take"}`,
    driver,
    seconds,
    keyframePath: null,
    billable,
    estimateUSD: billable ? q.estimateUSD : 0,
    quotedUSD: q.estimateUSD,
    estimateConfidence: q.confidence,
    actualUSD: null,
    state: "queued",
    error: null,
    jobId: null,
    path: null,
    submittedAt: new Date().toISOString(),
    finishedAt: null,
    elapsedMs: null,
  };
  shot.versions = shot.versions || [];
  shot.versions.push(version);
  return { version, q };
}

export async function submitUpscale(dir, opts) {
  const { version, q } = await store.withEpisode(dir, (ep) => commitUpscale(ep, opts));
  pending.push({ dir, versionId: version.id, shotId: version.shotId });
  pump();
  return { quote: q, version };
}

// ---------- stills ----------
//
// A board still is synchronous end-to-end (Gemini returns the image inline —
// no job id, no polling), so it skips the whole queue: unlike video, there is
// nothing to reattach after a restart and nothing to fan out in parallel.
// It reuses the SAME reference-omni-attach idea as the manual Nano Banana
// workflow (shot.refs -> the shot's approved character/location/prop assets)
// and the SAME prompt wording already shown in the copyable prompt box, so a
// generated still and its "Copy" text never diverge.
//
// Writes straight into the episode's own 03_storyboard/ — never the shared
// generated_imgs/ inbox — which is the whole point: this path exists so the
// board picker doesn't have to search a folder shared by every production.
// Guard 1 only (hard cap) — a still is a one-off, explicitly clicked action,
// not a batch fan-out, so the confirm-above-threshold step (guard 2 in
// commitFanOut) would just be friction for a ~$0.04 image.
function checkStillBudget(ep, est) {
  const led = ledgerState(ep);
  if (est.usd > led.remainingUSD) {
    throw new BudgetError(
      `Refused: estimated $${est.usd.toFixed(2)} exceeds the $${led.remainingUSD.toFixed(2)} left of this episode's $${led.budgetCapUSD.toFixed(2)} cap.`,
      { quote: { totalUSD: est.usd, ledger: led } },
    );
  }
}

// A filename never gets overwritten by a re-generation: an edit round that
// goes worse than the original must not destroy the original. `_v2`, `_v3`,
// ... on collision, same idea as store.js's copyWithoutClobber for promotes.
async function uniqueStillPath(dir, sub, baseName, ext) {
  for (let n = 1; n <= 999; n++) {
    const filename = n === 1 ? `${baseName}${ext}` : `${baseName}_v${n}${ext}`;
    const abs = store.safeResolve(dir, sub, filename);
    try { await fs.access(abs); } catch { return abs; }
  }
  throw new Error(`too many stills already named like ${baseName}`);
}

async function chargeStill(dir, shotId, beatId, frame, est, driver, modelId, extra = {}) {
  await store.withEpisode(dir, (ep2) => {
    const s2 = (ep2.shots || []).find((x) => x.id === shotId);
    const b2 = s2 && (s2.beats || []).find((x) => x.id === beatId);
    if (b2) b2.frame = frame;
    ep2.ledger = ep2.ledger || { budgetCapUSD: 25, confirmAboveUSD: 2, spentUSD: 0, entries: [] };
    ep2.ledger.spentUSD = round2((ep2.ledger.spentUSD || 0) + est.usd);
    ep2.ledger.entries.push({
      at: new Date().toISOString(),
      kind: "image",
      driver,
      model: modelId,
      shotId,
      beatId,
      estimateUSD: round2(est.usd),
      actualUSD: null,
      chargedUSD: round2(est.usd),
      outcome: "done",
      driftUSD: null,
      ...extra,
    });
    return b2;
  });
}

function requireBoardableBeat(ep, shotId, beatId) {
  const shot = (ep.shots || []).find((s) => s.id === shotId);
  if (!shot) throw Object.assign(new Error("shot not found"), { status: 404 });
  const idx = (shot.beats || []).findIndex((b) => b.id === beatId);
  const beat = idx >= 0 ? shot.beats[idx] : null;
  if (!beat) throw Object.assign(new Error("beat not found"), { status: 404 });
  if (!beat.keyframe) throw Object.assign(new Error("this beat isn't a keyframe beat — nothing to board"), { status: 400 });
  return { shot, beat, idx };
}

function requireReadyDriver(driverName) {
  const d = drivers[driverName];
  if (!d) throw Object.assign(new Error(`unknown driver "${driverName}"`), { status: 400 });
  const st = d.status();
  if (!st.ready) throw Object.assign(new Error(`driver "${driverName}" not ready: ${st.reason}`), { status: 503 });
  return d;
}

// Resolves a still-image model id (rates.js IMAGE_MODELS) to its driver
// instance and, for fal models, the specific endpoint for this call (text-to-
// image vs. edit — fal doesn't share one suffix across model families, so
// that mapping lives on the model entry, not guessed here).
function resolveStillModel(modelId, hasReferences) {
  const model = imageModel(modelId);
  if (!model) throw Object.assign(new Error(`unknown still model "${modelId}" — check rates.js IMAGE_MODELS`), { status: 400 });
  const d = requireReadyDriver(model.driver);
  const endpoint = model.endpoints ? (hasReferences ? model.endpoints.edit : model.endpoints.generate) : undefined;
  return { model, d, endpoint };
}

export async function generateStill({ dir, shotId, beatId, modelId = "gemini-3.1-flash-image-preview" }) {
  const ep = await store.loadEpisode(dir);
  const { shot, beat, idx } = requireBoardableBeat(ep, shotId, beatId);

  const prompt = resolveNano(shot, ep, beat);
  const refPaths = refAssets(shot, ep)
    .map((a) => a.path)
    .filter(Boolean)
    .map((p) => store.safeResolve(p));

  const { model, d, endpoint } = resolveStillModel(modelId, refPaths.length > 0);
  const est = estimateImageUSD(modelId);
  checkStillBudget(ep, est);

  const outAbs = await uniqueStillPath(dir, "03_storyboard", beatFrameName(shot, beat, idx), ".png");
  const result = refPaths.length
    ? await d.editImage({ prompt, referenceImages: refPaths, outPath: outAbs, endpoint, fmt: ep.fmt })
    : await d.generateImage({ prompt, outPath: outAbs, endpoint, fmt: ep.fmt });

  const frame = {
    path: store.relToRoot(outAbs),
    approved: false,
    generatedAt: new Date().toISOString(),
    driver: model.driver,
    model: modelId,
  };
  await chargeStill(dir, shotId, beatId, frame, est, model.driver, modelId);

  return { shotId, beatId, frame, referencesUsed: refPaths.length, promptUsed: prompt, ledger: ledgerState(await store.loadEpisode(dir)) };
}

// Conversational follow-up on the LAST generated still — the same move as
// typing a correction back to ChatGPT/Nano Banana: the previous frame goes in
// as the anchor reference (first, so identity/composition carries over) and
// the instruction describes only what should change. Requires an existing
// frame on the beat; this is "refine what's there," not a fresh generation.
// Always an edit call (there's always at least the previous frame as a
// reference), so it needs a model whose endpoints support editing.
export async function refineStill({ dir, shotId, beatId, instruction, modelId = "gemini-3.1-flash-image-preview" }) {
  if (!instruction || !instruction.trim()) throw Object.assign(new Error("an edit instruction is required"), { status: 400 });
  const ep = await store.loadEpisode(dir);
  const { shot, beat, idx } = requireBoardableBeat(ep, shotId, beatId);
  if (!beat.frame || !beat.frame.path) throw Object.assign(new Error("no existing still on this beat to refine — generate one first"), { status: 400 });

  const { model, d, endpoint } = resolveStillModel(modelId, true);
  const est = estimateImageUSD(modelId);
  checkStillBudget(ep, est);

  const basePrompt = resolveNano(shot, ep, beat);
  const prompt = `${basePrompt}

REVISION of the first reference image (the previous generation for this shot): ${instruction.trim()}. Keep everything else about that image — composition, characters, lighting, style — unchanged unless this revision says otherwise.`;

  const previousAbs = store.safeResolve(beat.frame.path);
  const otherRefPaths = refAssets(shot, ep)
    .map((a) => a.path)
    .filter(Boolean)
    .map((p) => store.safeResolve(p))
    .filter((p) => p !== previousAbs);
  const referenceImages = [previousAbs, ...otherRefPaths];

  const outAbs = await uniqueStillPath(dir, "03_storyboard", beatFrameName(shot, beat, idx), ".png");
  const result = await d.editImage({ prompt, referenceImages, outPath: outAbs, endpoint, fmt: ep.fmt });

  const frame = {
    path: store.relToRoot(outAbs),
    approved: false,
    generatedAt: new Date().toISOString(),
    driver: model.driver,
    model: modelId,
  };
  await chargeStill(dir, shotId, beatId, frame, est, model.driver, modelId, { instruction: instruction.trim(), revisionOf: beat.frame.path });

  return { shotId, beatId, frame, referencesUsed: referenceImages.length, promptUsed: prompt, ledger: ledgerState(await store.loadEpisode(dir)) };
}

// Cancel one take. Still waiting in our own queue: drop it, nothing was sent,
// nothing is charged. Already sent: ask the provider to drop it, and only mark
// it cancelled (uncharged) if the provider really did; otherwise the job keeps
// running and billing, so the take stays and the reason is returned.
export async function cancelVersion(dir, versionId) {
  const ep0 = await store.loadEpisode(dir);
  let v0 = null;
  for (const s of ep0.shots || []) { v0 = (s.versions || []).find((x) => x.id === versionId); if (v0) break; }
  if (!v0) throw Object.assign(new Error("take not found"), { status: 404 });
  if (v0.state !== "queued" && v0.state !== "running") throw Object.assign(new Error(`this take is already ${v0.state}`), { status: 409 });

  const i = pending.findIndex((p) => p.versionId === versionId);
  if (i >= 0) pending.splice(i, 1);
  else {
    if (!v0.jobId) throw Object.assign(new Error("This take is still being sent to the provider. Try again in a few seconds."), { status: 409 });
    const d = drivers[v0.driver];
    let r;
    try { r = await d.cancelJob({ jobId: v0.jobId, modelId: v0.modelId, statusUrl: v0.statusUrl }); }
    catch (err) { r = { cancelled: false, reason: err.message }; }
    if (!r.cancelled) throw Object.assign(new Error(`Could not cancel: ${r.reason || "the provider refused"}. The take keeps running; dismiss it after it lands if you don't want it.`), { status: 409 });
    cancelled.add(versionId);
  }
  const out = await store.withEpisode(dir, (ep) => {
    for (const s of ep.shots || []) {
      const v = (s.versions || []).find((x) => x.id === versionId);
      if (v && (v.state === "queued" || v.state === "running")) {
        Object.assign(v, { state: "cancelled", error: "Cancelled by you. Nothing was billed.", finishedAt: new Date().toISOString() });
        return { ...v };
      }
    }
    return null;
  });
  return { version: out };
}

// Is this version already being handled by THIS process? Anything on disk can
// look queued or running while a live job owns it.
function isTracked(versionId) {
  return running.has(versionId) || pending.some((p) => p.versionId === versionId);
}

function pump() {
  while (running.size < CONCURRENCY && pending.length) {
    const item = pending.shift();
    running.add(item.versionId);
    // .catch as well as .finally: runVersion's own failure path writes to disk,
    // and a failure THERE (a Drive permission blip, say) used to escape as an
    // unhandled rejection, which on Node 22 exits the process and orphans every
    // other paid generation in flight.
    runVersion(item)
      .catch((err) => console.error(`job ${item.versionId} failed hard: ${err && err.message}`))
      .finally(() => {
        running.delete(item.versionId);
        pump();
      });
  }
}

async function updateVersion(dir, versionId, patch) {
  return store.withEpisode(dir, (ep) => {
    for (const s of ep.shots || []) {
      const v = (s.versions || []).find((x) => x.id === versionId);
      if (v) { Object.assign(v, patch); return { ...v }; }
    }
    return null;
  });
}

// Applies a TERMINAL patch (done or error) and its ledger charge in ONE
// withEpisode callback, atomically.
//
// This exists because marking a version done and charging its ledger entry
// used to be two separate lock acquisitions: updateVersion(...state:"done")
// then postActualToLedger(...). ledgerState() derives in-flight spend by
// filtering on state queued/running — so the instant the first write lands,
// the clip stops counting as in-flight, and it does not start counting as
// spent until the second write lands after it. Any withEpisode call for the
// same episode queued in that gap — a fan-out commit, say — reads
// artificially inflated headroom and can be admitted over the cap by up to
// that one clip's estimate. episodeChains serializes each INDIVIDUAL write
// but makes no promise about a PAIR of them with a gap in between, and
// runVersion always awaits the first before starting the second, so the gap
// is real wall-clock time, not a single microtask. Folding both mutations
// into the one callback below means the cap-accounting view of this episode
// only ever exists in two states — this clip is in flight, or it is spent —
// never a third state where it is counted as neither.
async function settle(dir, knownVersion, patch, opts = {}) {
  const versionId = knownVersion.id;
  const charge = opts.charge !== undefined ? opts.charge : true;
  const outcome = opts.outcome || "done";
  return store.withEpisode(dir, (ep) => {
    let liveVersion = null;
    for (const s of ep.shots || []) {
      const v = (s.versions || []).find((x) => x.id === versionId);
      if (v) { liveVersion = v; break; }
    }
    if (liveVersion) Object.assign(liveVersion, patch);
    // `liveVersion` is null when the record was deleted from the tray while
    // its job was in flight. The money was still spent and the file is still
    // on disk, so the charge is built from what the caller already knew about
    // this version rather than silently dropped.
    const target = liveVersion || { ...knownVersion, ...patch };

    // A rehearsal on a driver that doesn't bill must not consume the real cap.
    if (charge && target.billable !== false) {
      ep.ledger = ep.ledger || { budgetCapUSD: 25, confirmAboveUSD: 2, spentUSD: 0, entries: [] };
      // Charge the actual when the provider reports one, otherwise the
      // estimate. Never charge nothing: an unbilled-looking run would
      // quietly free up cap.
      const charged = target.actualUSD != null ? target.actualUSD : target.estimateUSD;
      ep.ledger.spentUSD = round2((ep.ledger.spentUSD || 0) + charged);
      ep.ledger.entries.push({
        at: new Date().toISOString(),
        kind: "video",
        driver: target.driver,
        model: target.modelId,
        shotId: target.shotId,
        versionId: target.id,
        seconds: target.seconds,
        estimateUSD: target.estimateUSD,
        actualUSD: target.actualUSD,
        chargedUSD: charged,
        // "failed" means the provider was asked to do the work — and
        // therefore billed for it — but the take never landed here.
        outcome,
        // Drift is the signal that a rate in server/rates.js needs correcting.
        driftUSD: target.actualUSD != null ? round2(target.actualUSD - target.estimateUSD) : null,
      });
    }
    return liveVersion ? { ...liveVersion } : null;
  });
}

// Mark a version failed. A job that was SUBMITTED has already committed money
// at the provider whether or not a file ever came back, so the estimate has
// to be charged on the way out, or the cap silently gains back money that was
// really spent. A submission that never got a request id billed nothing and
// is charged nothing.
async function failVersion(dir, version, error, started, opts = {}) {
  const charge = opts.charge !== undefined ? opts.charge : !!version.jobId;
  try {
    await settle(
      dir, version,
      { state: "error", error, actualUSD: null, elapsedMs: started ? Date.now() - started : null },
      { charge, outcome: "failed" },
    );
  } catch (err) {
    // Recording a failure must never become a second, fatal failure.
    console.error(`could not record failure for version ${version.id}: ${err && err.message}`);
  }
}

// Runs one version to completion. `reattach` picks up a job that was already
// submitted before a restart: same polling, same download, same ledger posting,
// but it never re-submits — that is what would double-charge. Sharing one path
// also means a re-attached job respects CONCURRENCY, gets the same wall-clock
// ceiling, and pumps the queue when it finishes.
async function runVersion({ dir, versionId, reattach = false }) {
  const started = Date.now();
  let version = null;
  try {
    const ep = await store.loadEpisode(dir);
    for (const s of ep.shots || []) {
      const v = (s.versions || []).find((x) => x.id === versionId);
      if (v) { version = v; break; }
    }
    if (!version) return;
    if (version.state !== (reattach ? "running" : "queued")) return;

    const d = drivers[version.driver];
    if (!d) throw new Error(`unknown driver "${version.driver}"`);
    const shot = ep.shots.find((s) => s.id === version.shotId);

    let sub;
    if (reattach) {
      sub = { jobId: version.jobId, statusUrl: version.statusUrl, responseUrl: version.responseUrl };
    } else if (version.op === "lipsync") {
      if (typeof d.generateLipsync !== "function") throw new Error(`driver "${version.driver}" can't do lip sync`);
      sub = await d.generateLipsync({
        videoPath: store.safeResolve(version.sourcePath),
        audioPath: store.safeResolve(version.audioPath),
        syncMode: version.syncMode,
        modelId: version.modelId,
      });
      await updateVersion(dir, versionId, {
        state: "running", jobId: sub.jobId, statusUrl: sub.statusUrl, responseUrl: sub.responseUrl,
      });
      version.jobId = sub.jobId;
    } else if (version.op === "finish") {
      if (typeof d.generateFinish !== "function") throw new Error(`driver "${version.driver}" can't finish a draft`);
      sub = await d.generateFinish({ draftId: version.draftId, modelId: version.modelId });
      await updateVersion(dir, versionId, {
        state: "running", jobId: sub.jobId, statusUrl: sub.statusUrl, responseUrl: sub.responseUrl,
      });
      version.jobId = sub.jobId;
    } else if (version.op === "upscale") {
      if (typeof d.generateUpscale !== "function") throw new Error(`driver "${version.driver}" can't upscale`);
      const srcAbs = store.safeResolve(version.sourcePath);
      let fps = 24;
      try { fps = (await probe(srcAbs)).fps || 24; } catch { /* the quote's 24 fps stands */ }
      let sendPath = srcAbs, tmp = null;
      // Only the part used in the cut is sent (and paid for).
      if (version.spans && version.driver !== "mock") tmp = sendPath = await trimmedCopy(srcAbs, version.spans);
      try {
        sub = await d.generateUpscale({ videoPath: sendPath, modelId: version.modelId, target: version.target, fps });
      } finally {
        if (tmp) await fs.rm(tmp, { force: true });
      }
      await updateVersion(dir, versionId, {
        state: "running", jobId: sub.jobId, statusUrl: sub.statusUrl, responseUrl: sub.responseUrl,
      });
      version.jobId = sub.jobId;
    } else {
      // A frozen reference prompt means a reference model (an H3 Max
      // references take with no vault images still has its frozen prompt).
      const isRef = Array.isArray(version.referencePaths) && (version.referencePaths.length > 0 || typeof version.referencePrompt === "string");
      const prompt = isRef ? version.referencePrompt : resolveVideoPrompt(shot, ep, { style: (videoModel(version.modelId) || {}).promptStyle || null }).text;
      const keyframeAbs = store.safeResolve(version.keyframePath);
      const endKeyframeAbs = version.endKeyframePath ? store.safeResolve(version.endKeyframePath) : null;
      sub = await d.generateVideo({
        imagePath: keyframeAbs,
        endImagePath: endKeyframeAbs,
        referencePaths: isRef ? version.referencePaths.map((p) => store.safeResolve(p)) : undefined,
        referenceVideoPaths: isRef && version.referenceVideoPaths ? version.referenceVideoPaths.map((p) => store.safeResolve(p)) : undefined,
        aspectRatio: ep.fmt,
        prompt,
        seconds: version.seconds,
        modelId: version.modelId,
        audio: version.audio,
      });
      await updateVersion(dir, versionId, {
        state: "running", jobId: sub.jobId, statusUrl: sub.statusUrl, responseUrl: sub.responseUrl, prompt,
      });
      // Keep the local copy in step: from here on the provider is billing, and
      // failVersion decides whether to charge by looking at this field.
      version.jobId = sub.jobId;
    }

    // Poll until done. A wall-clock ceiling stops a hung job from occupying a
    // concurrency slot forever.
    const deadline = Date.now() + 20 * 60 * 1000;
    for (;;) {
      if (Date.now() > deadline) {
        await failVersion(dir, version, "timed out after 20 minutes", started);
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (cancelled.delete(versionId)) return;
      const st = await d.getJob({ jobId: sub.jobId, modelId: version.modelId, statusUrl: sub.statusUrl, responseUrl: sub.responseUrl });
      if (st.state === "error") {
        // fal answers 422 at the RESULT when the model itself refuses the inputs
        // (a content refusal: for Seedance, usually a realistic face in a
        // reference image). Those are not billed (Shawn's fal usage CSV,
        // 2026-10-07; Oct 16 Seedance 2.0 Fast refusal: same), so they are not
        // charged to the ledger either, and the message says what it probably is.
        const refused = /^result 422\b/.test(String(st.error || ""));
        await failVersion(
          dir, version,
          refused
            ? `fal's model refused these inputs (422), so nothing was billed. For Seedance this is usually a realistic face in a reference image: the Atlas rows accept them. fal said: ${String(st.error).slice(0, 500)}`
            : st.error,
          started,
          refused || st.noCharge ? { charge: false } : {},
        );
        return;
      }
      if (st.state !== "done") continue;

      const ext = ".mp4";
      const filename = takeFileName(shot, version, ext);
      const destAbs = store.safeResolve(dir, TAKES_SUBDIR, filename);
      await d.download(st.result.videoUrl, destAbs);

      // An upscale is conformed to its source (frame rate, exact size, audio).
      // A failure here never loses the paid-for file: it is kept as returned.
      let upscaleNote = null;
      if (version.op === "upscale" && version.driver !== "mock") {
        let conformSrc = null;
        try {
          // The file that was sent: the take, or the pieces cut from it. Its
          // frame rate, shape and sound are what the result must match.
          const takeAbs = store.safeResolve(version.sourcePath);
          if (version.spans) conformSrc = await trimmedCopy(takeAbs, version.spans);
          const c = await normalizeUpscaled(destAbs, { srcAbs: conformSrc || takeAbs, target: version.target });
          const parts = [c.fps && "frame rate", c.size && "size", c.audio && "audio"].filter(Boolean);
          if (parts.length) upscaleNote = `matched to the source take: ${parts.join(", ")}`;
        } catch (err) {
          upscaleNote = `kept as returned (could not match it to the source take: ${err.message})`;
        } finally {
          if (conformSrc) await fs.rm(conformSrc, { force: true });
        }
      }

      // A draft take remembers its id and when it stops being finishable.
      const isDraft = !!(videoModel(version.modelId) || {}).draft && !version.op;
      const patch = {
        ...(isDraft ? { draftId: version.jobId, draftExpiresAt: new Date(Date.now() + 7 * 864e5).toISOString() } : {}),
        ...(upscaleNote ? { upscaleNote } : {}),
        state: "done",
        path: store.relToRoot(destAbs),
        actualUSD: st.result.actualUSD ?? null,
        // H3 Max with expansion on: what the model actually received after
        // fal's rewrite (null when nothing was rewritten).
        expandedPrompt: (st.result.raw && typeof st.result.raw.expanded_prompt === "string") ? st.result.raw.expanded_prompt : null,
        finishedAt: new Date().toISOString(),
        elapsedMs: Date.now() - started,
      };
      // One lock acquisition for both the terminal state and its charge — see
      // settle()'s own comment for why that atomicity is the whole point.
      await settle(dir, version, patch);
      return;
    }
  } catch (err) {
    await failVersion(dir, version || { id: versionId }, err.message, started);
  }
}

// Re-attach polling for jobs that were in flight when the server stopped. Their
// ids and urls are on disk, so a restart doesn't orphan a paid-for generation.
export async function resumeInFlight() {
  const tree = await store.scan();
  const dirs = [
    ...tree.series.flatMap((s) => s.episodes.map((e) => e.dir)),
    ...tree.standalone.map((s) => s.dir),
  ];
  let resumed = 0;
  for (const dir of dirs) {
    const ep = await store.loadEpisode(dir);
    for (const s of ep.shots || []) {
      for (const v of s.versions || []) {
        if (v.state !== "queued" && v.state !== "running") continue;
        // NEVER re-queue work this process is already doing. A version stays
        // "queued" on disk for the whole duration of the driver's submit call
        // (downscale, upload, queue POST), and the server accepts requests
        // while this scan is still walking Drive — so a fan-out accepted a
        // moment ago looks exactly like an orphan, and re-queuing it submitted
        // and paid for the same clip twice.
        if (isTracked(v.id)) continue;
        if (v.state === "running" && !v.jobId) {
          // Submitted-but-unrecorded: the write was torn between the provider
          // accepting the job and its request id reaching disk. It cannot be
          // polled and must not be re-submitted, so retire it and charge the
          // estimate rather than leaving it pinned in flight against the cap.
          await failVersion(dir, v, "in-flight job lost its request id — retired on restart", null, { charge: true });
          continue;
        }
        // A job that was already submitted re-attaches to its existing request
        // id; only a still-queued one is submitted for the first time.
        pending.push({ dir, versionId: v.id, shotId: v.shotId, reattach: v.state === "running" });
        resumed += 1;
      }
    }
  }
  pump();
  return resumed;
}

export function queueDepth() {
  return { running: running.size, pending: pending.length, concurrency: CONCURRENCY };
}

// ---------- vault: generate reference images for an asset ----------
//
// The asset's own prompt (typed, or drafted by Claude) plus the episode's
// global style, the asset's identity hold and the ban list. References are
// other vault images the caller picks (usually this card's existing angles).
// Every image is charged to the ledger as kind "image" with the assetId, under
// the same per-episode cap as storyboard stills. Nothing is attached to the
// card here: the browser shows the variants and the creator files the keeper.
export async function generateAssetImages({ dir, assetId, prompt, modelId = "gemini-3.1-flash-image-preview", count = 1, refIds = [], fmt = null }) {
  if (!prompt || !String(prompt).trim()) throw Object.assign(new Error("a prompt is required"), { status: 400 });
  const n = Math.max(1, Math.min(4, Number(count) || 1));
  const ep = await store.loadEpisode(dir);
  const asset = (ep.assets || []).find((a) => a.id === assetId);
  if (!asset) throw Object.assign(new Error("asset not found"), { status: 404 });

  const hold = usableHold(asset.identityHold) || usableHold(((ep.assets || []).find((a) => a.type === asset.type && a.name.trim().toLowerCase() === asset.name.trim().toLowerCase() && usableHold(a.identityHold)) || {}).identityHold);
  const parts = [String(prompt).trim()];
  if (ep.style && ep.style.trim()) parts.push(`Style: ${ep.style.trim()}.`);
  if (hold) parts.push(hold);
  if (ep.ban && ep.ban.trim()) parts.push(`Avoid: ${ep.ban.trim()}`);
  const fullPrompt = parts.join("\n\n");

  const refPaths = [...new Set((refIds || [])
    .map((id) => (ep.assets || []).find((a) => a.id === id))
    .filter((a) => a && a.path)
    .map((a) => store.safeResolve(a.path)))];

  const { model, d, endpoint } = resolveStillModel(modelId, refPaths.length > 0);
  const est = estimateImageUSD(modelId, n);
  checkStillBudget(ep, est);
  const per = estimateImageUSD(modelId, 1);

  const base = `${slugifyName(asset.name)}${asset.angle ? `_${slugifyName(asset.angle)}` : ""}`;
  // A series card's images live with the series, not inside one episode.
  const sd = asset.fromSeries ? await store.seriesDirOf(dir) : null;
  const outDir = sd ? `${sd}/_RedClover` : dir;
  const paths = [];
  for (let i = 0; i < n; i++) {
    const outAbs = await uniqueStillPath(outDir, "02_assets/generated", base, ".png");
    if (refPaths.length) await d.editImage({ prompt: fullPrompt, referenceImages: refPaths, outPath: outAbs, endpoint, fmt: fmt || ep.fmt });
    else await d.generateImage({ prompt: fullPrompt, outPath: outAbs, endpoint, fmt: fmt || ep.fmt });
    const rel = store.relToRoot(outAbs);
    paths.push(rel);
    await store.withEpisode(dir, (ep2) => {
      ep2.ledger = ep2.ledger || { budgetCapUSD: 25, confirmAboveUSD: 2, spentUSD: 0, entries: [] };
      ep2.ledger.spentUSD = round2((ep2.ledger.spentUSD || 0) + per.usd);
      ep2.ledger.entries.push({
        at: new Date().toISOString(), kind: "image", driver: model.driver, model: modelId,
        assetId, path: rel, estimateUSD: round2(per.usd), actualUSD: null, chargedUSD: round2(per.usd),
        outcome: "done", driftUSD: null,
      });
    });
  }
  return { assetId, paths, promptUsed: fullPrompt, referencesUsed: refPaths.length, ledger: ledgerState(await store.loadEpisode(dir)) };
}

const slugifyName = (s) => String(s || "asset").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "asset";
