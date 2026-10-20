// Schema v2.
//
// The v1 desk stored `DB = {cur, prods:{id:{assets[],shots[]}}}` — flat, single
// production, and beat-blind: one `move`, one dialogue line and one `audio` per
// SHOT, which forced the timecoded draft to hang dialogue and SFX on the last
// beat. v2 pushes those fields down onto the beat and keeps the shot-level value
// as an inherited default, so v1 data migrates without loss and the old output is
// reproducible.
//
// Hierarchy: Series -> Episode -> Scene -> Shot -> Beat.
// A standalone production is an Episode with seriesId === null.

import { splitBeats } from "./grammar.js";

export const SCHEMA_VERSION = 2;

export const GATES = [
  { id: "G0", name: "Outline", desc: "Episode outline approved against the series bible" },
  { id: "G1", name: "Script", desc: "Script locked" },
  { id: "G2", name: "Asset lock", desc: "New-asset audit run; every required asset approved" },
  { id: "G3", name: "Board lock", desc: "Storyboard approved. No video generation before this gate." },
  { id: "G4", name: "Video", desc: "All shots generated and selected" },
  { id: "G5", name: "Delivery", desc: "Assembled, exported, QC passed" },
];

export const ASSET_TYPES = ["character", "location", "prop"];

export function uid() {
  return Math.random().toString(36).slice(2, 9);
}

// ---------- constructors ----------

export function newBeat(partial = {}) {
  return {
    id: partial.id || uid(),
    role: partial.role || "beat",       // start | mid | end | beat
    // Does this beat get its own generated still? v1 kept two granularities:
    // keyframe stills (start/mid/end) and narrative beats inside one generation.
    // One list, one flag, both preserved.
    keyframe: partial.keyframe !== undefined ? !!partial.keyframe : true,
    desc: partial.desc || "",
    // per-beat camera. null/"" means inherit the shot default.
    size: partial.size || "",
    angle: partial.angle || "",
    lens: partial.lens || "",
    move: partial.move || "",
    // the v1 gap, now per beat
    dialogue: partial.dialogue || null, // { charId, line, delivery }
    audio: partial.audio || "",
    music: partial.music || null,
    treatments: partial.treatments || [],
    durationSec: partial.durationSec ?? null, // null = estimate from desc
    frame: partial.frame || null,       // { path, approved, generatedAt, driver, model }
    // Hand-edited prompt text. Empty = use the auto-built prompt (buildNano/
    // buildGPT in shared/prompts.js); non-empty wins for BOTH what's shown in
    // the prompt box and what actually gets sent on Generate/Refine — editing
    // the box and generating from it must never diverge.
    nanoOverride: partial.nanoOverride || "",
    gptOverride: partial.gptOverride || "",
  };
}

export function newShot(partial = {}) {
  const s = {
    id: partial.id || uid(),
    sceneId: partial.sceneId || null,
    sceneNum: partial.sceneNum || "1",
    shotCode: partial.shotCode || "a",
    intext: partial.intext || "INT.",
    loc: partial.loc || "",
    time: partial.time || "DAY",
    label: partial.label || "",
    // shot-level camera defaults, inherited by beats
    size: partial.size || "MS",
    angle: partial.angle || "eye",
    lens: partial.lens || "50mm",
    // No default — a silently-defaulted "static" sailed into real prompts
    // unnoticed. Left blank, the UI has to show it as unchosen and the job
    // queue refuses to generate until Shawn actually picks one.
    move: partial.move || "",
    subjects: partial.subjects || "",
    action: partial.action || "",
    location: partial.location || "",
    lighting: partial.lighting || "",
    atmos: partial.atmos || "",
    audio: partial.audio || "",          // shot-level default sfx
    music: partial.music || null,
    refs: partial.refs || [],            // asset ids
    treatments: partial.treatments || [],
    custom: partial.custom || "",
    inheritStart: !!partial.inheritStart, // start frame = previous shot's end
    // Manual override of WHICH two approved keyframes feed video generation's
    // start/end image slots — null means "auto" (first/last approved, in beat
    // order). A shot can carry several approved storyboards purely to compare
    // combos; only these two ever get sent (shared/prompts.js resolveStartEndBeats).
    startBeatId: partial.startBeatId || null,
    endBeatId: partial.endBeatId || null,
    beats: partial.beats || [],
    timecodePrompt: partial.timecodePrompt || "",
    videoPromptOverride: partial.videoPromptOverride || "", // hand-edit of the Video JSON handoff box
    // blocking (Phase 2): camera + subject positions on a top-down plan
    blocking: partial.blocking || null,
    // Blocking joins the video prompt only when this is on (opt-in per shot).
    blockingInPrompt: !!partial.blockingInPrompt,
    // Motion references: [{ id, path, label, seconds, use }] (Blender previs,
    // grey-box, rehearsal clips) sent to models that take reference video.
    refVideos: partial.refVideos || [],
    versions: partial.versions || [],    // generated video takes (Phase 3)
    // Recorded dialogue (ElevenLabs etc.) imported for this shot — editorial,
    // free, follows Undo like an imported clip. { id, label, path, seconds,
    // importedFrom, addedAt }. Lip sync reads these; nothing else does yet.
    audioClips: partial.audioClips || [],
    // Ordered ids into `versions`. Order IS meaning: index 0 is the primary
    // take (drives the V1 spine and the timeline cursor); index 1+ are
    // alternates that land on their own stacked track (V2, V3...) at the
    // SAME timeline position, for auditioning/razoring in Resolve — see
    // server/timeline.js rebuildFromSelection. Migrates the old single
    // `selectedVersion` scalar into a one-element array.
    selectedVersions: partial.selectedVersions || (partial.selectedVersion ? [partial.selectedVersion] : []),
    imgDone: !!partial.imgDone,
    vidDone: !!partial.vidDone,
    notes: partial.notes || "",
    // The video model last picked for this shot in its Generate pane ("" =
    // use the episode default). A choice, not a take: nothing is generated.
    videoModelId: partial.videoModelId || "",
    // Length last picked in Generate (s); null = follow the storyboard timing.
    videoSeconds: partial.videoSeconds || null,
    // The usable part of a take, set on the take itself ("only 0:03–0:07 is
    // good"): { [versionId]: { inSec, outSec } }, either may be null (= start
    // / end of the file). The timeline and every export trim to it.
    takeTrims: partial.takeTrims || {},
  };
  if (!s.beats.length) s.beats = [newBeat({ role: "start", keyframe: true, desc: s.action, audio: s.audio, music: s.music })];
  return s;
}

// a, b, c, ..., z, aa, ab, ... — spreadsheet-column style, so a scene with
// more than 26 shots (never happened yet, but shouldn't silently break) still
// gets a legible, ordered code instead of colliding or throwing.
function letterForIndex(i) {
  let s = "";
  i += 1;
  while (i > 0) {
    const rem = (i - 1) % 26;
    s = String.fromCharCode(97 + rem) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

// Relabels shotCode (a, b, c...) for every shot sharing `sceneNum`, in their
// CURRENT ARRAY ORDER — which is the episode's one source of truth for shot
// sequence (episodeAxisWarnings, the timeline builder, and the Shots panel
// all already treat array order as sequence; nothing separately tracks
// "position within scene"). Call this after any insert/delete that could
// leave a gap or a duplicate letter, so a shot's code always matches where it
// actually sits, not where it sat when it was created.
export function renumberScene(shots, sceneNum) {
  let i = 0;
  for (const s of shots) {
    if (s.sceneNum !== sceneNum) continue;
    s.shotCode = letterForIndex(i);
    i += 1;
  }
  return shots;
}

const numOrNull = (n) => { const v = Number(n); return Number.isNaN(v) ? null : v; };

// Move a single shot into a DIFFERENT scene (shot/move only reorders within
// one scene — this is for "this shot actually belongs in scene 2, not 1").
// Keeps the episode's ascending-scene-number ordering invariant (array order
// IS scene sequence, same rule renumberScene relies on) whether the target
// scene already has shots or is currently empty. Syncs the shot's own
// intext/loc/time/location fields from the target scene's slugline, if one
// exists — a shot dragged into a new scene should carry that scene's setting,
// not the one it was drafted under. Both the source and target scene get
// re-lettered afterward.
export function moveShotToScene(ep, shotId, targetSceneNum, position = "start") {
  const shot = ep.shots.find((s) => s.id === shotId);
  if (!shot) throw Object.assign(new Error("shot not found"), { status: 404 });
  const target = String(targetSceneNum);
  const oldNum = shot.sceneNum;
  if (oldNum === target) throw Object.assign(new Error("shot is already in that scene"), { status: 400 });

  ep.shots.splice(ep.shots.indexOf(shot), 1);
  const inTarget = ep.shots.filter((s) => s.sceneNum === target);
  let insertAt;
  if (inTarget.length) {
    insertAt = position === "end"
      ? ep.shots.indexOf(inTarget[inTarget.length - 1]) + 1
      : ep.shots.indexOf(inTarget[0]);
  } else {
    // Scene has no shots (yet, or anymore) — land it in ascending-number
    // order among whatever scenes DO have shots, rather than defaulting to
    // either end of the whole episode.
    const tv = numOrNull(target);
    insertAt = tv == null ? ep.shots.length : ep.shots.findIndex((s) => (numOrNull(s.sceneNum) ?? Infinity) > tv);
    if (insertAt === -1) insertAt = ep.shots.length;
  }
  ep.shots.splice(insertAt, 0, shot);

  shot.sceneNum = target;
  const targetScene = (ep.scenes || []).find((sc) => sc.number === target);
  if (targetScene) {
    shot.intext = targetScene.intext || shot.intext;
    shot.loc = targetScene.loc || shot.loc;
    shot.time = targetScene.time || shot.time;
    shot.location = targetScene.loc || shot.location;
  }

  renumberScene(ep.shots, oldNum);
  renumberScene(ep.shots, target);
  return shot;
}

// Renumber scene `fromSceneNum` and every LATER scene by `delta` (e.g. -1 to
// close a gap after retiring an empty scene, +1 to open a slot for a new one
// mid-episode) — reassigns both ep.scenes[].number and every shot.sceneNum
// that falls in the shifted range, in one pass. Only ever touches numbers
// that parse as plain numbers (matches how scenes are actually numbered —
// see screenplay.js's straight incrementing counter); a non-numeric fromValue
// or a delta that isn't a nonzero integer is refused outright.
//
// Shifting UP (delta > 0) can never collide with anything, since the whole
// tail moves together into space above its own top. Shifting DOWN (delta < 0)
// is refused if any landing number is already occupied by content that
// ISN'T itself part of the range being shifted — silently overwriting scene
// data that was never asked to move would be exactly the kind of thing this
// app's "never invent, never silently discard" rule exists to prevent. Move
// or delete whatever's sitting in the way (moveShotToScene handles the
// shot side) before retrying.
export function shiftSceneNumbers(ep, fromSceneNum, delta) {
  const d = Number(delta);
  if (!Number.isInteger(d) || d === 0) throw Object.assign(new Error("delta must be a nonzero integer"), { status: 400 });
  const fromV = numOrNull(fromSceneNum);
  if (fromV == null) throw Object.assign(new Error("fromSceneNum must be a plain number — this tool doesn't handle lettered scene numbers"), { status: 400 });

  const affected = new Set();
  for (const sc of ep.scenes || []) { const v = numOrNull(sc.number); if (v != null && v >= fromV) affected.add(v); }
  for (const s of ep.shots || []) { const v = numOrNull(s.sceneNum); if (v != null && v >= fromV) affected.add(v); }
  if (!affected.size) throw Object.assign(new Error(`no scene numbered ${fromV} or later`), { status: 400 });

  if (d < 0) {
    for (const v of affected) {
      const landing = v + d;
      if (affected.has(landing)) continue; // moves together with the range — fine
      const occupied = (ep.shots || []).some((s) => numOrNull(s.sceneNum) === landing)
        || (ep.scenes || []).some((sc) => numOrNull(sc.number) === landing);
      if (occupied) {
        throw Object.assign(new Error(
          `can't shift — scene ${landing} already has content that wasn't asked to move. Move its shots elsewhere (or delete it if empty) first.`
        ), { status: 409 });
      }
    }
  }

  // Process farthest-from-the-gap first so a scene's new number never
  // collides with one still waiting its turn in this same batch.
  const order = [...affected].sort((a, b) => (d > 0 ? b - a : a - b));
  for (const v of order) {
    const next = String(v + d);
    for (const sc of ep.scenes || []) if (numOrNull(sc.number) === v) sc.number = next;
    for (const s of ep.shots || []) if (numOrNull(s.sceneNum) === v) s.sceneNum = next;
  }
  return { shifted: order.length, delta: d };
}

// Drag-and-drop: put a shot before another shot of the SAME scene (or at the
// scene's end when beforeShotId is null), then re-letter the scene. One call,
// one undo step.
export function reorderShot(ep, shotId, beforeShotId) {
  const shots = ep.shots || [];
  const i = shots.findIndex((s) => s.id === shotId);
  if (i < 0) throw Object.assign(new Error("shot not found"), { status: 404 });
  const scene = shots[i].sceneNum;
  if (beforeShotId) {
    const t = shots.find((s) => s.id === beforeShotId);
    if (!t) throw Object.assign(new Error("target shot not found"), { status: 404 });
    if (t.sceneNum !== scene) throw Object.assign(new Error("drag within a scene; use Move to scene to change scenes"), { status: 400 });
    if (t.id === shotId) return { moved: false };
  }
  const [shot] = shots.splice(i, 1);
  let at;
  if (beforeShotId) at = shots.findIndex((s) => s.id === beforeShotId);
  else { at = -1; shots.forEach((s, k) => { if (s.sceneNum === scene) at = k; }); at += 1; }
  shots.splice(at, 0, shot);
  renumberScene(shots, scene);
  return { moved: true, sceneNum: scene, codes: shots.filter((s) => s.sceneNum === scene).map((s) => `${s.sceneNum}${s.shotCode}`) };
}

// Drag-and-drop for scenes: `order` lists the current scene numbers in their
// new sequence; scenes are renumbered 1..n in that order and every shot moves
// with its scene (array order is scene order). A scene keeps its screenplay
// number in scriptNumber the first time its number changes, the same
// convention Organize uses, so script lookups still find it. The "Cut from
// edit" bin (X) is left alone and stays last.
export function reorderScenes(ep, order, cutScene = "X") {
  const nums = (ep.scenes || []).map((sc) => String(sc.number)).filter((n) => n !== cutScene);
  const shotNums = [...new Set((ep.shots || []).map((s) => String(s.sceneNum)).filter((n) => n !== cutScene))];
  const all = [...new Set([...nums, ...shotNums])];
  const want = (order || []).map(String);
  if (want.length !== all.length || !all.every((n) => want.includes(n))) {
    throw Object.assign(new Error("order must list every scene exactly once"), { status: 400 });
  }
  const map = new Map(want.map((n, k) => [n, String(k + 1)]));
  for (const sc of ep.scenes || []) {
    const old = String(sc.number);
    if (!map.has(old)) continue;
    const next = map.get(old);
    if (next !== old && sc.scriptNumber == null) sc.scriptNumber = old;
    sc.number = next;
  }
  for (const s of ep.shots || []) if (map.has(String(s.sceneNum))) s.sceneNum = map.get(String(s.sceneNum));
  const rankN = (n) => (String(n) === cutScene ? Infinity : Number(n));
  ep.scenes = [...(ep.scenes || [])].sort((a, b) => rankN(a.number) - rankN(b.number));
  const rank = (s) => rankN(s.sceneNum);
  // Stable sort keeps each scene's internal shot order.
  ep.shots = (ep.shots || []).map((s, k) => [s, k]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([s]) => s);
  return { renumbered: [...map].filter(([a, b]) => a !== b).length };
}

export function newAsset(partial = {}) {
  return {
    id: partial.id || uid(),
    type: partial.type || "character",
    name: partial.name || "",
    // v1 stored only a text label in `file`. v2 keeps it for provenance and adds
    // `path`, a real file relative to the episode (or series) folder.
    file: partial.file || "",
    path: partial.path || "",
    approved: !!partial.approved,
    angle: partial.angle || "",          // front | 3q | profile | back | plate | ...
    derivedFrom: partial.derivedFrom || null, // asset id this was generated from
    identityHold: partial.identityHold || "", // the phrasing that survived the Arm B test
    driftNotes: partial.driftNotes || "",
    voice: partial.voice || "",
    seriesCanon: !!partial.seriesCanon,  // promoted into the series registry
    vault: !!partial.vault,              // a full series card (see newSeries)
    // Other names the script (or a human) uses for this same asset — "Serge"
    // for the registry's "Serge Stitch" — so the new-asset audit counts them
    // as standing instead of flagging a naming mismatch as a new asset.
    aliases: partial.aliases || [],
    // Free-form organizing labels ("Workshop interiors", "Heist crew"). Purely
    // for browsing the vault — unlike `type`, nothing in the audit, prompts or
    // folder layout reads them.
    tags: normalizeTags(partial.tags),
  };
}

// Trim, drop empties, dedupe case-insensitively (first spelling wins), cap length.
export function normalizeTags(tags) {
  const seen = new Set(), out = [];
  for (const t of Array.isArray(tags) ? tags : []) {
    const v = String(t == null ? "" : t).trim().slice(0, 32);
    if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); }
  }
  return out;
}

export function newScene(partial = {}) {
  return {
    id: partial.id || uid(),
    number: partial.number || "1",
    heading: partial.heading || "",
    intext: partial.intext || "INT.",
    loc: partial.loc || "",
    time: partial.time || "DAY",
    synopsis: partial.synopsis || "",
    characters: partial.characters || [],   // speaking roles (had a Character cue)
    extras: partial.extras || [],           // named but non-speaking roles seen in action lines
    props: partial.props || [],             // draft — confirm each; see shared/screenplay.js
    pageStart: partial.pageStart ?? null,
  };
}

export function newEpisode(partial = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: partial.id || uid(),
    seriesId: partial.seriesId || null,
    name: partial.name || "Untitled production",
    number: partial.number ?? null,
    dir: partial.dir || "",
    gate: partial.gate || "G0",
    gateLog: partial.gateLog || [],
    // G0 outline-lock fields (series-pm.md): named at G0, checked at review.
    hook: partial.hook || "",
    cliffhanger: partial.cliffhanger || "",
    // Resolutions for new-asset-audit rows that can't simply be built —
    // { "<type>:<normalized name>": "waived" | "approved" }. "approved" here
    // means "handled outside the registry" (rare); the normal path for a new
    // asset is building it and adding it to the series registry, which makes
    // the audit re-run standing on its own.
    assetAuditOverrides: partial.assetAuditOverrides || {},
    fmt: partial.fmt || "9:16",
    style: partial.style || "",
    ban: partial.ban || "",
    lean: !!partial.lean,
    scriptPath: partial.scriptPath || "",
    scenes: partial.scenes || [],
    shots: partial.shots || [],
    assets: partial.assets || [],
    timeline: partial.timeline || newTimeline(),
    exports: partial.exports || [],   // [{ kind: 'fcpxml'|'otio'|'capcut', path, at }]
    ledger: partial.ledger || newLedger(),
    jobs: partial.jobs || [],
    // Set only on a remaster episode: { sourceDir, xmlPath, createdAt,
    // handlesSec, cutSeconds, leftOut[], audioNeeds[] } (server/remaster.js).
    // Listed here because ensureV2 rebuilds episodes from this field list and
    // drops anything it doesn't name.
    remaster: partial.remaster || null,
    // Model a shot's Generate pane starts on when the shot has no choice of
    // its own (videoModelFor). null = the first model in rates.js.
    defaultVideoModelId: partial.defaultVideoModelId || null,
    // Claude's latest suggestions, kept until Shawn uses or discards them so
    // they survive a reload and show however they were run:
    // { drafts: { [shotId]: result }, proposals: { [sceneId]: result } }.
    claude: partial.claude || { drafts: {}, proposals: {}, assets: {} },
    updatedAt: partial.updatedAt || new Date().toISOString(),
  };
}

// Which video model a shot's Generate pane starts on: the shot's own last
// pick, else the episode default, else the first model offered. A stale id
// (model removed from rates.js) falls through to the next rule.
export function videoModelFor(shot, ep, modelIds) {
  const ok = (id) => id && modelIds.includes(id);
  if (ok(shot && shot.videoModelId)) return shot.videoModelId;
  if (ok(ep && ep.defaultVideoModelId)) return ep.defaultVideoModelId;
  return modelIds[0] || null;
}

// The sellable length closest to a remaster shot's target (Shawn, 2026-10-09:
// rounding UP made 5b a 7 s take for a 6.17 s target, and H3 Max stretched the
// action to fill it). Ties go to the longer length.
export function nearestSellable(durations, target) {
  const ds = [...(durations || [5])].map(Number).sort((a, b) => a - b);
  const t = Number(target);
  if (!Number.isFinite(t)) return ds[0];
  return ds.reduce((best, d) => (Math.abs(d - t) < Math.abs(best - t) || (Math.abs(d - t) === Math.abs(best - t) && d > best) ? d : best), ds[0]);
}

export function newSeries(partial = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: partial.id || uid(),
    name: partial.name || "Untitled series",
    dir: partial.dir || "",
    biblePath: partial.biblePath || "series.md",
    fmt: partial.fmt || "9:16",
    style: partial.style || "",
    ban: partial.ban || "",
    lean: !!partial.lean,
    registry: partial.registry || [],   // approved canon assets, shared across episodes
    // Entries with vault: true are full series cards (images, holds, voices),
    // merged into every episode's vault; others are name-only placeholders the
    // Missing audit counts. New episodes start from these defaults:
    defaultVideoModelId: partial.defaultVideoModelId || null,
    episodes: partial.episodes || [],   // [{ id, name, dir, number, gate }]
    updatedAt: partial.updatedAt || new Date().toISOString(),
  };
}

export function newTimeline(partial = {}) {
  return {
    fps: partial.fps || 24,
    // Dialogue/SFX/music text pulled from the shot/beat data at the last
    // timeline rebuild — see server/timeline.js. Text, not clips: the
    // pipeline doesn't produce separate audio FILES yet (see
    // server/export/capcut.js for why), so there's nothing to place as a
    // clip on A1-A3. This is what the edit sheet's "Audio cues" section
    // reads from.
    audioCues: partial.audioCues || [],
    tracks: partial.tracks || [
      { id: "V1", kind: "video", name: "Picture", clips: [] },
      { id: "A1", kind: "audio", name: "Dialogue", clips: [] },
      { id: "A2", kind: "audio", name: "SFX", clips: [] },
      { id: "A3", kind: "audio", name: "Music", clips: [] },
    ],
  };
}

// A timeline clip. `sourceDurationSec` is measured from the real file via
// ffprobe, never guessed — the trim UI needs a true ceiling to validate
// against. headTrimSec/tailTrimSec are the ramp-up/ramp-down cut, per
// house-style.md ("trim first/last ~0.5-2s ramp-up per clip") — that range is
// a starting suggestion for a human or Claude to confirm by eye per clip, not
// a value this app invents and applies blindly.
export function newTimelineClip(partial = {}) {
  return {
    id: partial.id || uid(),
    shotId: partial.shotId || null,
    versionId: partial.versionId || null,   // the generated take this clip came from, if any
    sourcePath: partial.sourcePath || "",   // project-relative
    name: partial.name || "",
    kind: partial.kind || "video",          // video | dialogue | sfx | music
    sourceDurationSec: partial.sourceDurationSec ?? null, // ffprobe-measured; null = unmeasured
    headTrimSec: partial.headTrimSec ?? 0,
    tailTrimSec: partial.tailTrimSec ?? 0,
    startSec: partial.startSec ?? 0,        // position on the timeline
    text: partial.text || "",               // dialogue line / sfx description, for the audio cue sheet
    // A take with cut-outs makes several clips from one file: which piece this
    // is (0-based) and how many there are. Absent on an ordinary clip.
    ...(partial.spanCount > 1 ? { spanIndex: partial.spanIndex ?? 0, spanCount: partial.spanCount } : {}),
  };
}

// Effective (post-trim) duration. Clamped to zero — over-trimming a clip must
// never produce a negative-length clip on the timeline.
export function clipDurationSec(clip) {
  if (clip.sourceDurationSec == null) return 0; // unmeasured — ffprobe hasn't run yet
  return Math.max(0, clip.sourceDurationSec - (clip.headTrimSec || 0) - (clip.tailTrimSec || 0));
}

export function newLedger(partial = {}) {
  return {
    budgetCapUSD: partial.budgetCapUSD ?? 25,      // per episode. Enforced by the job queue.
    confirmAboveUSD: partial.confirmAboveUSD ?? 2, // any single batch above this needs explicit confirmation
    spentUSD: partial.spentUSD ?? 0,
    entries: partial.entries || [],                // { at, driver, model, kind, shotId, seconds, costUSD, jobId }
  };
}

// ---------- beat helpers ----------

// Resolve a beat's effective camera, falling back to the shot default.
export function beatCam(shot, beat) {
  return {
    size: (beat && beat.size) || shot.size,
    angle: (beat && beat.angle) || shot.angle,
    lens: (beat && beat.lens) || shot.lens,
    move: (beat && beat.move) || shot.move,
  };
}

// A beat's audio. Deliberately NOT inherited from the shot: migration already
// placed the shot-level values on the beat that owned them, so falling back here
// would repeat the same SFX on every beat of the timecoded script.
// shot.audio / shot.music survive only as the seed value for newly created beats
// and as the whole-shot fallback in buildVideo.
export function beatAudio(shot, beat) {
  return {
    sfx: (beat && beat.audio) || "",
    music: (beat && beat.music) || null,
    dialogue: beat ? beat.dialogue : null,
  };
}

export function beatTreatments(shot, beat) {
  const set = new Set([...(shot.treatments || []), ...((beat && beat.treatments) || [])]);
  return [...set];
}

// ---------- v1 -> v2 migration ----------

// v1 encoded beats as a `kf` mode plus three description fields. Rebuild them as
// an ordered beat list, and move the shot-level move/dialogue/audio/music onto the
// LAST beat — which is exactly where v1's timecoded draft put them, so migrated
// episodes reproduce their old output byte for byte.
export function beatsFromV1Shot(v1) {
  const kf = v1.kf || "single";

  // Multi-keyframe: every beat is a still, and carries its own camera override.
  if (kf !== "single") {
    const slots = [["start", v1.startDesc || ""]];
    if (kf === "start_mid_end") slots.push(["mid", v1.midDesc || ""]);
    slots.push(["end", v1.endDesc || ""]);
    return slots.map(([role, desc], i) => {
      const last = i === slots.length - 1;
      return newBeat({
        role,
        keyframe: true,
        desc,
        size: v1[`${role}Size`] || "",
        angle: v1[`${role}Angle`] || "",
        lens: v1[`${role}Lens`] || "",
        move: v1[`${role}Move`] || "",
        dialogue: last && v1.diaLine && v1.diaLine.trim()
          ? { charId: v1.diaChar || null, line: v1.diaLine.trim(), delivery: v1.diaDelivery || "neutral" }
          : null,
        audio: last ? (v1.audio || "") : "",
        music: last ? (v1.music || null) : null,
      });
    });
  }

  // Single keyframe: ONE still, but v1 split the action sentence into narrative
  // beats for the timecoded draft. Materialise that split as real beats — the
  // first is the still, the rest are timing-only — and hang dialogue and SFX on
  // the last, which is where v1 put them.
  const parts = splitBeats(v1.action || v1.subjects || "");
  const descs = parts.length ? parts : [v1.startDesc || v1.action || "(describe the beat)"];
  return descs.map((desc, i) => {
    const last = i === descs.length - 1;
    return newBeat({
      role: i === 0 ? "start" : "beat",
      keyframe: i === 0,
      desc,
      dialogue: last && v1.diaLine && v1.diaLine.trim()
        ? { charId: v1.diaChar || null, line: v1.diaLine.trim(), delivery: v1.diaDelivery || "neutral" }
        : null,
      audio: last ? (v1.audio || "") : "",
      music: last ? (v1.music || null) : null,
    });
  });
}

export function migrateShotV1(v1) {
  return newShot({ ...v1, beats: beatsFromV1Shot(v1) });
}

export function migrateAssetV1(v1) {
  return newAsset({ ...v1, file: v1.file || "", path: "" });
}

// Accepts either a v1 export ({cur, prods:{...}}) or a single v1 production object.
export function migrateProductionV1(prod, opts = {}) {
  return newEpisode({
    id: prod.id || uid(),
    seriesId: opts.seriesId || null,
    name: prod.name || "Untitled production",
    dir: opts.dir || "",
    fmt: prod.fmt || "9:16",
    style: prod.style || "",
    ban: prod.ban || "",
    lean: !!prod.lean,
    assets: (prod.assets || []).map(migrateAssetV1),
    shots: (prod.shots || []).map(migrateShotV1),
  });
}

export function migrateExportV1(db, opts = {}) {
  if (!db || !db.prods) throw new Error("not a v1 export: missing .prods");
  return Object.values(db.prods).map((p) => migrateProductionV1(p, opts));
}

// Idempotent: hand it anything, get schema v2 back.
//
// THE BUG THIS GUARDS AGAINST: when a field is added to newEpisode() (or one
// of the nested constructors) after episodes already exist on disk, an early
// return of the raw loaded document — "schemaVersion already matches, ship
// it as-is" — skips defaulting entirely. The new field is silently undefined
// on every episode that predates the change, and the first thing that
// touches it throws. That happened here: `exports` was added to newEpisode
// in Phase 4, and a real Phase-0-vintage episode on disk had no such field —
// an export route's `ep.exports.push(...)` threw AFTER the file was already
// written, so the write silently succeeded while the log entry silently
// didn't.
//
// The fix is running EVERY already-v2 document back through the
// constructors, not just new/migrated ones — they're idempotent by design
// (every field is `partial.field ?? default`), so this only fills gaps, it
// never clobbers real data. Nested structures that have their own
// constructor get the same treatment one level down, since a field added to
// newTimeline() or newLedger() later would hit the identical bug otherwise.
export function ensureV2(doc, opts = {}) {
  if (!doc) return newEpisode(opts);
  if (doc.prods) {
    const eps = migrateExportV1(doc, opts);
    return eps.length === 1 ? eps[0] : eps;
  }
  // ">= SCHEMA_VERSION", not "===": a document stamped 3 (a future bump) or
  // "2" (one hand-edit) is still v2-shaped data, but strict equality sent it
  // down migrateProductionV1 below, which keeps a handful of fields, rebuilds
  // beats from v1 shapes, and silently discards the ledger, gate, gateLog,
  // scenes, timeline and exports of a perfectly good episode.
  if (Number(doc.schemaVersion) >= SCHEMA_VERSION) {
    return newEpisode({
      ...doc,
      ...opts,
      timeline: newTimeline(doc.timeline || {}),
      ledger: newLedger({ ...(doc.ledger || {}) }),
    });
  }
  if (Array.isArray(doc.shots)) return migrateProductionV1(doc, opts);
  return newEpisode({ ...doc, ...opts });
}

// Deleting one angle of a multi-angle card (e.g. an empty slot left beside the
// real image, 2026-10-10) must not drop the card from shots that point at that
// angle's id: their refs move to a remaining angle of the same card (one with
// an image first). A card's last angle just goes. Returns the heir or null.
export function removeAssetKeepRefs(ep, assetId) {
  const gone = (ep.assets || []).find((a) => a.id === assetId);
  ep.assets = (ep.assets || []).filter((a) => a.id !== assetId);
  if (!gone) return null;
  const key = (a) => `${a.type}:${(a.name || "").trim().toLowerCase()}`;
  const heir = ep.assets.find((a) => key(a) === key(gone) && a.path) || ep.assets.find((a) => key(a) === key(gone)) || null;
  if (heir) {
    for (const s of ep.shots || []) {
      if (!(s.refs || []).includes(gone.id)) continue;
      s.refs = s.refs.includes(heir.id) ? s.refs.filter((r) => r !== gone.id) : s.refs.map((r) => (r === gone.id ? heir.id : r));
    }
  }
  return heir;
}
