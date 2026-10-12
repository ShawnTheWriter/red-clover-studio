// "Organize folders and footage from XML": make the episode match Shawn's
// Resolve cut. Decisions agreed with Shawn 2026-10-07:
// - Scenes renumber to the order they appear in the cut. The renumbered
//   number is the true number from now on; the screenplay's number is kept on
//   the scene as `scriptNumber`, shown in parentheses — a just-in-case, since
//   production is now off script.
// - Shots inside a scene take the order of their first appearance in the cut.
// - Shots with nothing in the cut go to the "Cut from edit" bin at the END of
//   the episode (sceneNum "X"). Never deleted: they may come back.
// - Take videos and storyboard images inside the episode folder are renamed to
//   the new shot codes. Files used only by binned shots move to _archive/cut/.
// - Resolve links by absolute path, so every apply also writes a relinked copy
//   of Shawn's FCPXML. Never rename without it.
//
// planOrganize is pure (the preview). applyOrganize repeats the same plan
// under the episode lock and refuses if it differs from what was previewed.

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import * as store from "./store.js";
import * as cut from "./cut.js";
import { renumberScene } from "../shared/schema.js";
import { writeSceneBinScripts } from "./resolve-script.js";

export const CUT_SCENE = "X";
const pad2 = (n) => (/^\d$/.test(String(n)) ? `0${n}` : String(n));
const num = (n) => { const v = Number(n); return Number.isNaN(v) ? null : v; };
const isDone = (v) => v.state === "done" && v.path;

// A leading shot code in a file name: "2a_", "02a ", "2T_", "12bc-".
const CODE_PREFIX = /^\d{1,3}[a-zA-Z]{1,2}(?:[ _-]+|(?=\.))/;
const stripCode = (base) => base.replace(CODE_PREFIX, "");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

// Storyboards use the padded code ("02a", like shotCodeStr); takes use the
// bare code ("2a", like the job queue's file names).
function codeFor(relFile, sceneNum, shotCode) {
  return relFile.includes("/03_storyboard/") ? `${pad2(sceneNum)}${shotCode}` : `${sceneNum}${shotCode}`;
}

// Every file path a shot owns that this tool may rename: its takes and its
// storyboard frames, only when they live inside this episode's own folder.
function shotFiles(shot, epDir) {
  const out = new Set();
  const inside = (p) => p && !path.isAbsolute(p) && p.startsWith(`${epDir}/`) && !p.startsWith(`${epDir}/_archive/`);
  for (const v of shot.versions || []) if (inside(v.path)) out.add(v.path);
  for (const b of shot.beats || []) if (b.frame && inside(b.frame.path)) out.add(b.frame.path);
  return [...out];
}

export function planOrganize(ep, analysis, { epDir, exists = () => true } = {}) {
  const warnings = [];
  const info = new Map(analysis.shots.map((s) => [s.shotId, s]));

  // ---- which shots go to the bin
  // A shot that never had a finished take could not have been in the cut, so
  // it is new work, not a cut: it stays in its scene.
  const binned = new Set();
  for (const s of ep.shots) {
    if (s.sceneNum === CUT_SCENE) {
      binned.add(s.id);
      if (info.get(s.id)?.status === "in") warnings.push(`${s.sceneNum}${s.shotCode} is in the cut but sits in Cut from edit — restore it to a scene first`);
      continue;
    }
    const a = info.get(s.id);
    if (a && a.status === "cut" && (s.versions || []).some(isDone)) binned.add(s.id);
  }

  // ---- scene map: cut order first, then every other numbered scene that
  // still has a record or a shot, in its old order. Nothing is dropped.
  const sceneMap = new Map();
  let next = 1;
  for (const n of analysis.sceneOrder) if (n !== CUT_SCENE && !sceneMap.has(n)) sceneMap.set(n, String(next++));
  const rest = new Set([...(ep.scenes || []).map((sc) => String(sc.number)), ...ep.shots.filter((s) => !binned.has(s.id)).map((s) => String(s.sceneNum))]);
  for (const n of [...rest].filter((n) => !sceneMap.has(n) && n !== CUT_SCENE).sort((a, b) => (num(a) ?? Infinity) - (num(b) ?? Infinity))) {
    sceneMap.set(n, String(next++));
  }

  // ---- new shot order: by new scene, then first appearance in the cut
  // (picture first, else first use of its sound); shots with no cut info keep
  // their old relative order after the ones that have it. Binned shots last.
  const firstUse = (s) => {
    const a = info.get(s.id);
    if (!a) return Infinity;
    if (a.firstAt != null) return a.firstAt;
    if (a.audioUses.length) return Math.min(...a.audioUses.map((u) => u.start));
    return Infinity;
  };
  const oldIndex = new Map(ep.shots.map((s, i) => [s.id, i]));
  const kept = ep.shots.filter((s) => !binned.has(s.id)).map((s) => ({ s, scene: sceneMap.get(String(s.sceneNum)) }));
  kept.sort((x, y) => num(x.scene) - num(y.scene) || firstUse(x.s) - firstUse(y.s) || oldIndex.get(x.s.id) - oldIndex.get(y.s.id));
  const bin = ep.shots.filter((s) => binned.has(s.id)).sort((x, y) => oldIndex.get(x.id) - oldIndex.get(y.id));

  // Letters, computed the same way renumberScene does.
  const order = [...kept.map((k) => ({ shot: k.s, scene: k.scene })), ...bin.map((s) => ({ shot: s, scene: CUT_SCENE }))];
  const counts = new Map();
  const letter = (i) => { let s = ""; i += 1; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(97 + r) + s; i = Math.floor((i - 1) / 26); } return s; };
  const shots = order.map(({ shot, scene }) => {
    const i = counts.get(scene) || 0;
    counts.set(scene, i + 1);
    const a = info.get(shot.id);
    return {
      shotId: shot.id, label: shot.label || "",
      fromScene: String(shot.sceneNum), fromCode: `${shot.sceneNum}${shot.shotCode}`,
      toScene: scene, toCode: `${scene}${letter(i)}`, toLetter: letter(i),
      status: binned.has(shot.id) ? "cut" : (a ? a.status : "new"),
    };
  });
  const byShot = new Map(shots.map((x) => [x.shotId, x]));

  // ---- files: one owner per file. A file shared by several shots belongs to
  // the first kept shot in the new order; only if every user is binned does
  // it go to the archive.
  const owners = new Map();
  for (const { shot } of order) for (const f of shotFiles(shot, epDir)) {
    if (!owners.has(f)) owners.set(f, []);
    owners.get(f).push(shot.id);
  }
  const renames = [];
  const taken = new Set();
  for (const [f, ids] of owners) {
    if (!exists(f)) { warnings.push(`missing on disk, left as is: ${f}`); continue; }
    const keptOwner = ids.find((id) => !binned.has(id));
    const dir = path.posix.dirname(f), base = path.posix.basename(f);
    const ext = path.posix.extname(base), stem = stripCode(base.slice(0, base.length - ext.length));
    let to, reason;
    if (keptOwner) {
      const p = byShot.get(keptOwner);
      to = `${dir}/${codeFor(f, p.toScene, p.toLetter)}_${stem}${ext}`;
      reason = "rename";
    } else {
      const shot = ep.shots.find((s) => s.id === ids[0]);
      const relInEp = path.posix.relative(epDir, dir);
      to = `${epDir}/_archive/cut/${relInEp}/${codeFor(f, shot.sceneNum, shot.shotCode)}_${stem}${ext}`;
      reason = "archive";
    }
    if (to === f) continue;
    // Never land on a file that exists and is not itself moving away, and
    // never send two files to one name.
    const movingAway = (p) => owners.has(p) && p !== to;
    let n = 2, cand = to;
    while (taken.has(cand) || (exists(cand) && !movingAway(cand))) cand = to.replace(new RegExp(`${ext.replace(".", "\\.")}$`), `_${n++}${ext}`);
    taken.add(cand);
    renames.push({ from: f, to: cand, reason, shots: ids.map((id) => byShot.get(id).toCode) });
  }

  const scenes = [...sceneMap].map(([from, to]) => {
    const rec = (ep.scenes || []).find((sc) => String(sc.number) === from);
    return { from, to, scriptNumber: rec ? (rec.scriptNumber ?? from) : from, heading: rec ? rec.heading : "", inCut: analysis.sceneOrder.includes(from) };
  });
  const plan = { scenes, shots, renames, warnings, binCount: bin.length };
  plan.planHash = sha(JSON.stringify({ scenes, shots, renames }));
  return plan;
}

// Replace every string value in `obj` that equals an old path.
function rewritePaths(obj, map) {
  if (Array.isArray(obj)) return obj.forEach((v, i) => { if (typeof v === "string" && map.has(v)) obj[i] = map.get(v); else if (v && typeof v === "object") rewritePaths(v, map); });
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === "string" && map.has(v)) obj[k] = map.get(v);
    else if (v && typeof v === "object") rewritePaths(v, map);
  }
}

// Relink Shawn's FCPXML: every media src pointing at a renamed file points at
// its new name. Clip names in the timeline are left alone (they are his).
export function relinkFcpxml(xmlText, absMap) {
  let changed = 0;
  const out = xmlText.replace(/(<(?:media-rep|asset)\b[^>]*?\bsrc=")([^"]+)(")/g, (m, a, src, b) => {
    const abs = cut.fileUrlToPath(src.replace(/&amp;/g, "&"));
    if (!absMap.has(abs)) return m;
    changed += 1;
    return `${a}file://${encodeURI(absMap.get(abs)).replace(/&/g, "&amp;")}${b}`;
  });
  return { xml: out, changed };
}

const existsSync = async (rel) => fs.access(store.safeResolve(rel)).then(() => true, () => false);

async function existsMap(ep, epDir) {
  // Collect every candidate path once so the pure planner can ask "exists?"
  // synchronously.
  const seen = new Set();
  for (const s of ep.shots) for (const f of shotFiles(s, epDir)) seen.add(f);
  const ok = new Set();
  for (const f of seen) if (await existsSync(f)) ok.add(f);
  return ok;
}

export async function previewOrganize(dir, xmlPath) {
  const ep = await store.loadEpisode(dir);
  const analysis = cut.analyzeCut(ep, cut.parseCut(await cut.readCutFile(store.safeResolve(xmlPath))), store.ROOT);
  const ok = await existsMap(ep, dir);
  // Targets: a name not in the episode's file set is checked lazily below.
  const plan = planOrganize(ep, analysis, { epDir: dir, exists: (p) => ok.has(p) });
  for (const r of plan.renames) if (!ok.has(r.to) && await existsSync(r.to)) plan.warnings.push(`target already exists, apply will refuse: ${r.to}`);
  return { xmlPath, ...plan, unmatched: analysis.unmatched, ambiguous: analysis.ambiguous };
}

const ORG_DIR = "05_delivery/organize";

async function movePlan(pairs) {
  // Two phases through temporary names, so a chain or swap (2c->2d while
  // 2d->2e) can't overwrite anything. Every completed step is recorded so a
  // failure part-way puts every file back.
  const done = [];
  const tmp = (p) => `${p}.rcs-organize-tmp`;
  try {
    for (const { from } of pairs) { await fs.rename(store.safeResolve(from), store.safeResolve(tmp(from))); done.push([tmp(from), from]); }
    for (const { from, to } of pairs) {
      const abs = store.safeResolve(to);
      if (await existsSync(to)) throw new Error(`target exists: ${to}`);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.rename(store.safeResolve(tmp(from)), abs);
      done.splice(done.findIndex((d) => d[1] === from), 1);
      done.push([to, from]);
    }
  } catch (e) {
    for (const [now, orig] of done.reverse()) await fs.rename(store.safeResolve(now), store.safeResolve(orig)).catch(() => {});
    throw Object.assign(new Error(`Organize stopped, every file was put back: ${e.message}`), { status: 409 });
  }
}

export async function applyOrganize(dir, xmlPath, planHash) {
  let result;
  await store.withEpisode(dir, async (ep) => {
    const before = JSON.stringify(ep);
    const analysis = cut.analyzeCut(ep, cut.parseCut(await cut.readCutFile(store.safeResolve(xmlPath))), store.ROOT);
    const ok = await existsMap(ep, dir);
    const plan = planOrganize(ep, analysis, { epDir: dir, exists: (p) => ok.has(p) });
    if (plan.planHash !== planHash) throw Object.assign(new Error("The episode changed since the preview. Preview again."), { status: 409 });
    if (analysis.unmatched.length || analysis.ambiguous.length) throw Object.assign(new Error("Some clips in the XML don't match a take. Fix that first."), { status: 409 });
    if (ep.shots.some((s) => (s.versions || []).some((v) => v.state === "queued" || v.state === "running"))) {
      throw Object.assign(new Error("A take is still generating. Wait for it to finish."), { status: 409 });
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const orgRel = `${dir}/${ORG_DIR}/${stamp}`;
    await fs.mkdir(store.safeResolve(orgRel), { recursive: true });
    await fs.writeFile(store.safeResolve(`${orgRel}/studio.before.json`), before, "utf8");

    await movePlan(plan.renames);

    // ---- the episode: scenes, shots, paths
    const sceneTo = new Map(plan.scenes.map((s) => [s.from, s]));
    for (const sc of ep.scenes || []) {
      const m = sceneTo.get(String(sc.number));
      if (!m) continue;
      if (sc.scriptNumber == null) sc.scriptNumber = String(sc.number);
      sc.number = m.to;
    }
    (ep.scenes || []).sort((a, b) => (num(a.number) ?? Infinity) - (num(b.number) ?? Infinity));
    const byId = new Map(ep.shots.map((s) => [s.id, s]));
    ep.shots = plan.shots.map((p) => {
      const s = byId.get(p.shotId);
      if (p.toScene === CUT_SCENE && s.sceneNum !== CUT_SCENE) s.cutFromEdit = { at: new Date().toISOString(), fromCode: p.fromCode, xmlPath };
      s.sceneNum = p.toScene;
      return s;
    });
    for (const n of new Set(ep.shots.map((s) => s.sceneNum))) renumberScene(ep.shots, n);
    rewritePaths(ep, new Map(plan.renames.map((r) => [r.from, r.to])));

    // Undo snapshots from before this point hold the old file paths, so an
    // Undo across it would break links. They move into the organize folder;
    // "Reverse last organize" is the way back.
    const hist = store.safeResolve(`${dir}/.history`);
    if (await fs.access(hist).then(() => true, () => false)) await fs.rename(hist, store.safeResolve(`${orgRel}/history`));

    // ---- relinked FCPXML for Resolve
    const absMap = new Map(plan.renames.map((r) => [store.safeResolve(r.from), store.safeResolve(r.to)]));
    const src = await cut.readCutFile(store.safeResolve(xmlPath));
    const { xml, changed } = relinkFcpxml(src, absMap);
    const base = path.basename(xmlPath).replace(/\.fcpxmld?$/i, "");
    const relinked = `${dir}/05_delivery/${base} (relinked ${stamp.slice(0, 10)} ${stamp.slice(11, 13)}${stamp.slice(14, 16)}).fcpxml`;
    await fs.writeFile(store.safeResolve(relinked), xml, "utf8");

    const map = {
      at: new Date().toISOString(), xmlPath, relinked, relinkedClips: changed,
      scenes: plan.scenes, shots: plan.shots, renames: plan.renames,
      afterHash: null, reversed: false,
    };
    result = { orgRel, map };
  });
  // The hash of the file as saved, so Reverse can tell whether anything was
  // edited after the organize.
  const after = await fs.readFile(store.safeResolve(`${dir}/studio.json`), "utf8");
  result.map.afterHash = sha(after);
  await fs.writeFile(store.safeResolve(`${result.orgRel}/map.json`), JSON.stringify(result.map, null, 2), "utf8");
  // New codes and paths: refresh the Resolve scene-bins script to match.
  const binsScript = await writeSceneBinScripts(await store.loadEpisode(dir), store.ROOT, store.safeResolve(dir)).catch((e) => ({ error: e.message }));
  return { organizeFolder: result.orgRel, relinked: result.map.relinked, relinkedClips: result.map.relinkedClips, renamed: result.map.renames.length, binned: result.map.shots.filter((s) => s.toScene === CUT_SCENE).length, binsScript };
}

export async function lastOrganize(dir) {
  const base = store.safeResolve(`${dir}/${ORG_DIR}`);
  const names = (await fs.readdir(base).catch(() => [])).sort().reverse();
  for (const n of names) {
    const map = await fs.readFile(path.join(base, n, "map.json"), "utf8").then(JSON.parse, () => null);
    if (map && !map.reversed) return { folder: `${dir}/${ORG_DIR}/${n}`, map };
  }
  return null;
}

// Puts files back and restores the episode as it was before the organize.
// Refused if the episode was edited afterwards: restoring the old file would
// silently drop that work (including paid takes).
export async function reverseOrganize(dir) {
  const last = await lastOrganize(dir);
  if (!last) throw Object.assign(new Error("No organize to reverse."), { status: 400 });
  let out;
  await store.withEpisode(dir, async (ep) => {
    const now = await fs.readFile(store.safeResolve(`${dir}/studio.json`), "utf8");
    if (sha(now) !== last.map.afterHash) {
      throw Object.assign(new Error("The episode was edited after the organize, so reversing it would lose that work. Undo those edits first, or restore single shots from the Cut from edit bin."), { status: 409 });
    }
    await movePlan(last.map.renames.map((r) => ({ from: r.to, to: r.from })).reverse());
    const before = JSON.parse(await fs.readFile(store.safeResolve(`${last.folder}/studio.before.json`), "utf8"));
    for (const k of Object.keys(ep)) delete ep[k];
    Object.assign(ep, before);
    // Any snapshots taken after the organize hold the NEW paths; park them
    // beside the map rather than mixing them with the restored history.
    const curHist = store.safeResolve(`${dir}/.history`);
    if (await fs.access(curHist).then(() => true, () => false)) await fs.rename(curHist, store.safeResolve(`${last.folder}/history-after`));
    const hist = store.safeResolve(`${last.folder}/history`);
    if (await fs.access(hist).then(() => true, () => false)) await fs.rename(hist, curHist);
    // The relinked FCPXML points at names that no longer exist. Park it with
    // the map so it can't be imported by mistake.
    const rl = last.map.relinked && store.safeResolve(last.map.relinked);
    if (rl && await fs.access(rl).then(() => true, () => false)) await fs.rename(rl, store.safeResolve(`${last.folder}/${path.basename(last.map.relinked)}`));
    out = { restoredFiles: last.map.renames.length };
  });
  last.map.reversed = new Date().toISOString();
  await fs.writeFile(store.safeResolve(`${last.folder}/map.json`), JSON.stringify(last.map, null, 2), "utf8");
  return out;
}
