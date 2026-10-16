// File-backed project store.
//
// The app and the red-clover-studios skill share the same folder tree on disk.
// That shared tree IS the integration: Claude writes shot lists and assets, the
// app reads them, and both leave artifacts a human can open. Nothing lives in a
// database and nothing lives in localStorage.
//
// Layout:
//   <root>/<Series>/                 series.json + a bible markdown (canon)
//   <root>/<Series>/<Episode>/       studio.json + the 00_..05_ scaffold
//   <root>/<Production>/             studio.json, standalone (seriesId null)

import fs from "node:fs/promises";
import path from "node:path";
import { ensureV2, newSeries, newEpisode, SCHEMA_VERSION } from "../shared/schema.js";
import { readSettings, writeSettings } from "./settings.js";

// The projects folder: RCS_PROJECT_ROOT, else the user's settings file, else
// none yet — the app then opens on "Choose your projects folder". It can be
// changed while the app runs (setRoot); every module reads store.ROOT, which
// is a live binding, so they all see the change.
export let ROOT = process.env.RCS_PROJECT_ROOT || readSettings().projectRoot || null;
export let GENERATED_ROOT = ROOT ? path.join(path.dirname(ROOT), "generated_imgs") : null;
export const ROOT_FROM_ENV = !!process.env.RCS_PROJECT_ROOT;

// Pick (and optionally create) the projects folder. Absolute paths only; a
// leading ~ means the home folder. Saved to the settings file.
export async function setRoot(input, { create = false } = {}) {
  let p = String(input || "").trim();
  if (p.startsWith("~")) p = path.join(process.env.HOME || "", p.slice(1));
  if (!path.isAbsolute(p)) throw Object.assign(new Error("Give the full path of a folder (it starts with / or ~)."), { status: 400 });
  p = path.resolve(p);
  const st = await fs.stat(p).catch(() => null);
  if (!st && create) await fs.mkdir(p, { recursive: true });
  else if (!st) throw Object.assign(new Error(`There's no folder at ${p}. Tick "create it" to make one.`), { status: 404 });
  else if (!st.isDirectory()) throw Object.assign(new Error(`${p} is a file, not a folder.`), { status: 400 });
  await fs.readdir(p); // EPERM surfaces here, with macOS's own message
  ROOT = p;
  GENERATED_ROOT = path.join(path.dirname(ROOT), "generated_imgs");
  writeSettings({ projectRoot: p });
  return ROOT;
}

const SERIES_FILE = "series.json";
const EPISODE_FILE = "studio.json";
const SCAFFOLD = ["00_script", "01_shotlist", "02_assets", "03_storyboard", "04_video_prompts", "05_delivery"];

// ---------- path safety ----------

// Every path that arrives from the browser is resolved and confirmed to sit
// inside ROOT before any read or write.
export function safeResolve(...parts) {
  if (!ROOT) throw Object.assign(new Error("Choose a projects folder first (Library → first-run screen)."), { status: 409 });
  const p = path.resolve(ROOT, ...parts);
  const rel = path.relative(ROOT, p);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes project root: ${parts.join("/")}`);
  }
  return p;
}

export const relToRoot = (abs) => path.relative(ROOT, abs);

// ---------- io ----------

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function readJSON(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}

// Atomic write. Google Drive's sync client has been seen to pick up partial
// files; write beside the target and rename, which is atomic on the same volume.
let writeSeq = 0;

async function writeJSON(p, data) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  // Unique per write, not just per process: a fan-out finishes several jobs at
  // once in ONE process, so a pid-only suffix had them racing on the same temp
  // file and the loser failed with ENOENT on rename.
  const tmp = `${p}.${process.pid}.${Date.now().toString(36)}.${(writeSeq += 1).toString(36)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, p);
  return p;
}

// A readdir failure here used to vanish silently into an empty array —
// indistinguishable from a genuinely empty folder. Log it so the cause is in
// /tmp/red-clover-studio.log; scan() below also surfaces a root failure to the UI.
function logReaddirFailure(dir, err) {
  console.error(`[store] readdir failed for ${dir}: ${err && err.message}`);
}

async function listDirs(dir) {
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    return ents.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  } catch (err) { logReaddirFailure(dir, err); return []; }
}

async function listFiles(dir) {
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    return ents.filter((e) => e.isFile() && !e.name.startsWith(".")).map((e) => e.name);
  } catch (err) { logReaddirFailure(dir, err); return []; }
}

// ---------- discovery ----------

// A bible is series.md, or anything matching "* series *.md" — Man in the Glass
// calls its canon "Man in Glass series bible.md". .gdoc stubs are Google Drive
// pointers, not content, and are ignored: the local markdown is authoritative.
function findBible(files) {
  const md = files.filter((f) => f.toLowerCase().endsWith(".md"));
  return md.find((f) => f.toLowerCase() === "series.md")
    || md.find((f) => /series[ _-]*bible/i.test(f))
    || md.find((f) => /\bseries\b/i.test(f))
    || null;
}

async function looksLikeEpisode(dir) {
  if (await exists(path.join(dir, EPISODE_FILE))) return true;
  if (await exists(path.join(dir, "production.md"))) return true;
  const names = [...(await listDirs(dir)), ...(await listFiles(dir))];
  return SCAFFOLD.some((s) => names.some((n) => n.startsWith(s)));
}

// Scan ROOT and return the full tree. Cheap enough to run per request; the tree
// is a couple of dozen directories.
export async function scan() {
  const out = { root: ROOT, series: [], standalone: [], rootError: null, needsRoot: !ROOT };
  if (!ROOT) return out;
  // Check the root directly so a failure reaches the Library screen instead of
  // looking like "no productions". EPERM here is macOS privacy protection: the
  // server was started by a process without Full Disk Access (the Sep 2026
  // incident — the Dock applet ran the server itself instead of via Terminal).
  try {
    await fs.readdir(ROOT);
  } catch (err) {
    logReaddirFailure(ROOT, err);
    out.rootError = { code: err.code || null, message: err.message };
    return out;
  }
  for (const name of await listDirs(ROOT)) {
    const dir = path.join(ROOT, name);
    const files = await listFiles(dir);
    const bible = findBible(files);
    const hasSeriesJson = files.includes(SERIES_FILE);

    if (bible || hasSeriesJson) {
      const episodes = [];
      for (const sub of await listDirs(dir)) {
        const subdir = path.join(dir, sub);
        if (await looksLikeEpisode(subdir)) {
          const doc = await readJSON(path.join(subdir, EPISODE_FILE));
          episodes.push({
            dir: relToRoot(subdir),
            name: doc?.name || sub,
            number: doc?.number ?? null,
            gate: doc?.gate || "G0",
            initialised: !!doc,
            shots: doc?.shots?.length ?? null,
          });
        }
      }
      out.series.push({
        dir: relToRoot(dir),
        name: name,
        bible: bible ? relToRoot(path.join(dir, bible)) : null,
        initialised: hasSeriesJson,
        episodes,
      });
    } else if (await looksLikeEpisode(dir)) {
      const doc = await readJSON(path.join(dir, EPISODE_FILE));
      out.standalone.push({
        dir: relToRoot(dir),
        name: doc?.name || name,
        gate: doc?.gate || "G0",
        initialised: !!doc,
        shots: doc?.shots?.length ?? null,
      });
    }
  }
  return out;
}

// ---------- series ----------

export async function loadSeries(relDir) {
  const dir = safeResolve(relDir);
  const doc = await readJSON(path.join(dir, SERIES_FILE));
  if (doc) return ensureV2Series(doc, relDir);
  const files = await listFiles(dir);
  const bible = findBible(files);
  return newSeries({
    name: path.basename(dir),
    dir: relDir,
    biblePath: bible || "series.md",
  });
}

function ensureV2Series(doc, relDir) {
  if (doc.schemaVersion === SCHEMA_VERSION) return { ...doc, dir: relDir };
  return newSeries({ ...doc, dir: relDir });
}

export async function saveSeries(relDir, series) {
  const dir = safeResolve(relDir);
  const doc = { ...series, dir: relDir, schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString() };
  await writeJSON(path.join(dir, SERIES_FILE), doc);
  return doc;
}

export async function readBible(relDir) {
  const series = await loadSeries(relDir);
  if (!series.biblePath) return null;
  const p = safeResolve(relDir, series.biblePath);
  try { return await fs.readFile(p, "utf8"); } catch { return null; }
}

// ---------- episodes ----------

export async function loadEpisode(relDir) {
  const dir = safeResolve(relDir);
  const doc = await readJSON(path.join(dir, EPISODE_FILE));
  const ep = doc ? ensureV2(doc, { dir: relDir }) : newEpisode({ name: path.basename(dir), dir: relDir });
  if (!Array.isArray(ep)) await mergeSeriesVault(ep, relDir);
  return ep;
}

// ---------- series vault ----------
//
// Series cards live in <Series>/series.json `registry` with vault: true (the
// name-only entries there stay placeholders for the Missing audit). Every
// episode load merges them into ep.assets tagged fromSeries, so prompts,
// references, voices and jobs see one list. Every save strips them back out of
// studio.json and writes any change, or any new series card, to series.json.
// Deleting a series card inside an episode is not propagated (it comes back on
// the next load): leaving the series is the explicit demote route.
export async function seriesDirOf(relDir) {
  const parent = path.dirname(relToRoot(safeResolve(relDir)));
  if (!parent || parent === ".") return null;
  return (await readJSON(path.join(safeResolve(parent), SERIES_FILE))) ? parent : null;
}

async function mergeSeriesVault(ep, relDir) {
  const sd = await seriesDirOf(relDir);
  if (!sd) return;
  const series = await readJSON(path.join(safeResolve(sd), SERIES_FILE));
  const have = new Set((ep.assets || []).map((a) => a.id));
  ep.assets = ep.assets || [];
  for (const a of (series.registry || []).filter((x) => x.vault)) {
    if (!have.has(a.id)) ep.assets.push({ ...a, fromSeries: true });
  }
}

async function syncSeriesVault(relDir, cards) {
  const sd = await seriesDirOf(relDir);
  if (!sd) return;
  const p = path.join(safeResolve(sd), SERIES_FILE);
  const series = await readJSON(p);
  const registry = series.registry || [];
  let changed = false;
  for (const card of cards) {
    const clean = { ...card, vault: true };
    delete clean.fromSeries;
    const i = registry.findIndex((r) => r.id === clean.id);
    if (i < 0) { registry.push({ approved: true, seriesCanon: true, ...clean }); changed = true; }
    else if (JSON.stringify(registry[i]) !== JSON.stringify({ ...registry[i], ...clean })) { registry[i] = { ...registry[i], ...clean }; changed = true; }
  }
  if (changed) await saveSeries(sd, { ...series, registry });
}

// Serializes read-modify-write cycles per episode file.
//
// Without this, two jobs finishing at the same moment each do
// load -> mutate -> save against the SAME base state, and the second save
// silently discards the first one's changes. For a cost ledger that means a
// charge quietly disappearing and the budget cap under-counting real spend,
// which is the one failure this whole subsystem exists to prevent.
//
// Anything that reads an episode, changes it, and writes it back must go
// through here rather than calling loadEpisode/saveEpisode as a pair.
const episodeChains = new Map();

// Undo history. `history: true` (every edit made from the app's UI) saves the
// episode as it was BEFORE the edit into <episode>/.history/, newest last,
// capped at HISTORY_MAX. Job-queue writes (jobs.js) don't pass it: undo is for
// the filmmaker's edits, not the background machinery.
const HISTORY_DIR = ".history";
const HISTORY_MAX = 100;

async function listHistory(dirAbs) {
  const files = await fs.readdir(path.join(dirAbs, HISTORY_DIR)).catch(() => []);
  return files.filter((f) => f.endsWith(".json")).sort();
}

async function pushHistory(dirAbs, beforeJson) {
  const hdir = path.join(dirAbs, HISTORY_DIR);
  await fs.mkdir(hdir, { recursive: true });
  const name = `${Date.now().toString().padStart(15, "0")}-${(writeSeq += 1).toString(36)}.json`;
  await fs.writeFile(path.join(hdir, name), beforeJson, "utf8");
  const all = await listHistory(dirAbs);
  for (const old of all.slice(0, Math.max(0, all.length - HISTORY_MAX))) {
    await fs.unlink(path.join(hdir, old)).catch(() => {});
  }
}

export async function historyDepth(relDir) {
  return (await listHistory(safeResolve(relDir))).length;
}

// Restore the newest snapshot. Money and machine state are NEVER rolled back:
// the cost ledger, job queue, exports and each shot's generated video takes
// come from the CURRENT file — undoing an edit must not un-record a paid
// generation or orphan a running job.
export function undoEpisode(relDir) {
  return withEpisode(relDir, async (ep) => {
    const dirAbs = safeResolve(relDir);
    const all = await listHistory(dirAbs);
    if (!all.length) throw Object.assign(new Error("nothing to undo"), { status: 400 });
    const newest = path.join(dirAbs, HISTORY_DIR, all[all.length - 1]);
    const snap = JSON.parse(await fs.readFile(newest, "utf8"));
    const cur = JSON.parse(JSON.stringify(ep));
    for (const k of Object.keys(ep)) delete ep[k];
    Object.assign(ep, snap, { ledger: cur.ledger, jobs: cur.jobs, exports: cur.exports });
    const curShots = new Map((cur.shots || []).map((s) => [s.id, s]));
    // Generated takes (paid) always come from the current file. Imported or
    // reused clips cost nothing and are an edit like any other, so those
    // follow the snapshot — undoing an import removes it.
    const free = (v) => v.driver === "import" || v.driver === "reuse";
    const snapIds = new Set((snap.shots || []).map((s) => s.id));
    const stranded = (cur.shots || []).filter((s) => !snapIds.has(s.id) && (s.versions || []).some((v) => !free(v)));
    if (stranded.length) {
      throw Object.assign(new Error(`can't undo: shot ${stranded.map((s) => s.sceneNum + s.shotCode).join(", ")} holds a generated (paid) take that this undo would drop — move that take to another shot first`), { status: 409 });
    }
    for (const s of ep.shots || []) {
      const c = curShots.get(s.id);
      const paid = ((c && c.versions) || []).filter((v) => !free(v));
      s.versions = [...(s.versions || []).filter(free), ...paid];
      const ids = new Set(s.versions.map((v) => v.id));
      // Selections follow the snapshot, like any other edit. Paid takes are
      // protected by being kept (above), not by staying selected: force-keeping
      // current selections meant "select take" could never be undone
      // (Shawn, 2026-10-12).
      s.selectedVersions = (s.selectedVersions || []).filter((id) => ids.has(id));
      // SFX variants are paid too (fal): the snapshot's list gains any the
      // current file has, so undo never loses one.
      if (c && c.sfx && (c.sfx.takes || []).length) {
        s.sfx = s.sfx || { prompt: c.sfx.prompt, takes: [], useId: null };
        const have = new Set((s.sfx.takes || []).map((t) => t.id));
        s.sfx.takes = [...(s.sfx.takes || []), ...c.sfx.takes.filter((t) => !have.has(t.id))];
      }
    }
    await fs.unlink(newest);
    return { remaining: all.length - 1 };
  });
}

export function withEpisode(relDir, fn, { history = false } = {}) {
  // Key the chain by the CANONICAL path, not the caller's spelling. "EP" and
  // "EP/" (or any two strings that resolve to the same directory) took
  // separate chains under a bare relDir key, so two callers editing the same
  // episode with a differently-spelled path never serialized against each
  // other at all — the lock existed and did nothing.
  const key = relToRoot(safeResolve(relDir));
  const prev = episodeChains.get(key) || Promise.resolve();
  const run = prev.then(async () => {
    const ep = await loadEpisode(relDir);
    const before = history ? JSON.stringify(ep) : null;
    const result = await fn(ep);
    // Only a real change earns a snapshot, or a no-op save would make Undo
    // appear to do nothing.
    if (history && JSON.stringify(ep) !== before) await pushHistory(safeResolve(relDir), before);
    await saveEpisode(relDir, ep);
    return result;
  });
  // A rejected link must not poison the chain for later writers.
  episodeChains.set(key, run.catch(() => {}));
  return run;
}

export async function saveEpisode(relDir, episode) {
  const dir = safeResolve(relDir);
  const all = episode.assets || [];
  const seriesCards = all.filter((a) => a.fromSeries);
  const doc = { ...episode, assets: all.filter((a) => !a.fromSeries), dir: relDir, schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString() };
  await writeJSON(path.join(dir, EPISODE_FILE), doc);
  if (seriesCards.length) await syncSeriesVault(relDir, seriesCards);
  return { ...doc, assets: all };
}

export async function scaffold(relDir) {
  const dir = safeResolve(relDir);
  for (const s of SCAFFOLD) await fs.mkdir(path.join(dir, s), { recursive: true });
  await fs.mkdir(path.join(dir, "02_assets", "characters"), { recursive: true });
  await fs.mkdir(path.join(dir, "02_assets", "locations"), { recursive: true });
  await fs.mkdir(path.join(dir, "02_assets", "props"), { recursive: true });
  return relToRoot(dir);
}

// ---------- migration from v1 exports ----------

// Find the v1 desk's JSON exports sitting in an episode folder. The desk wrote
// two shapes: the full database ({cur, prods:{...}}) and, from the per-production
// Export button, a bare production object. Accept either.
function v1Productions(doc) {
  if (!doc || typeof doc !== "object") return null;
  if (doc.prods) return Object.values(doc.prods);
  if (Array.isArray(doc.shots) && Array.isArray(doc.assets)) return [doc];
  return null;
}

export async function findV1Exports(relDir) {
  const dir = safeResolve(relDir);
  const out = [];
  for (const f of await listFiles(dir)) {
    if (!f.toLowerCase().endsWith(".json") || f === EPISODE_FILE || f === SERIES_FILE) continue;
    const prods = v1Productions(await readJSON(path.join(dir, f)));
    if (!prods) continue;
    const stat = await fs.stat(path.join(dir, f));
    out.push({
      file: f,
      mtime: stat.mtime.toISOString(),
      bytes: stat.size,
      productions: prods.map((p) => ({
        name: p.name, shots: (p.shots || []).length, assets: (p.assets || []).length,
      })),
    });
  }
  // Newest first: the most recent export is the one that should win.
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

// Import one v1 export into an episode folder.
export async function importV1(relDir, file, opts = {}) {
  const dir = safeResolve(relDir);
  // Never import over live work. This writes a whole episode rebuilt from the
  // v1 export, so an existing studio.json loses its cost ledger, its generated
  // takes and its gate history — silently, with the video files left orphaned
  // on disk. Re-running the migration is an easy accident; make it say no.
  if (!opts.overwrite && await exists(path.join(dir, EPISODE_FILE))) {
    throw Object.assign(
      new Error(`${relDir} already has ${EPISODE_FILE} — importing would replace its ledger, takes and gate history. Move it aside first, or pass overwrite:true.`),
      { status: 409 },
    );
  }
  const prods = v1Productions(await readJSON(path.join(dir, file)));
  if (!prods) throw new Error(`${file} is not a v1 desk export`);
  const prod = opts.productionName ? prods.find((p) => p.name === opts.productionName) : prods[0];
  if (!prod) throw new Error(`production "${opts.productionName}" not found in ${file}`);
  const ep = ensureV2(prod, { dir: relDir, seriesId: opts.seriesId || null });
  ep.dir = relDir;
  ep.seriesId = opts.seriesId || null;
  ep.name = opts.name || prod.name;
  ep.migratedFrom = file;
  if (opts.number != null) ep.number = opts.number;
  return saveEpisode(relDir, ep);
}

// ---------- copy for CapCut export ----------

export async function copyFile(relFrom, relTo) {
  const from = safeResolve(relFrom);
  const to = safeResolve(relTo);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
  return relToRoot(to);
}

export async function writeText(relPath, text) {
  const abs = safeResolve(relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, "utf8");
  return relToRoot(abs);
}

// ---------- generated-images inbox ----------
//
// Nano Banana's default output directory is `…/<workspace>/generated_imgs/` — a
// SIBLING of the project root, not inside it (the skill's documented
// workflow: "move/copy keepers into the production's 02_assets/ folder and
// rename them"). That's a deliberate, narrow exception to the normal path
// confinement: this module can READ from the inbox and COPY out of it into
// the confined project root, but nothing ever writes back into the inbox or
// resolves an arbitrary path there — every inbox access takes a bare
// filename, never a path with separators.

// GENERATED_ROOT (declared with ROOT above): the shared cross-project inbox
// beside the projects folder.

function safeInboxName(name) {
  if (!GENERATED_ROOT) throw Object.assign(new Error("Choose a projects folder first."), { status: 409 });
  if (!name || /[\/]/.test(name) || name.startsWith(".")) {
    throw new Error("invalid inbox filename");
  }
  return path.join(GENERATED_ROOT, name);
}

const INBOX_IMG_RX = /\.(png|jpe?g|webp|gif)$/i;

export async function listGeneratedImages(limit = 60) {
  let ents;
  try { ents = await fs.readdir(GENERATED_ROOT, { withFileTypes: true }); }
  catch { return []; }
  const files = [];
  for (const e of ents) {
    if (!e.isFile() || !INBOX_IMG_RX.test(e.name)) continue;
    const st = await fs.stat(path.join(GENERATED_ROOT, e.name));
    files.push({ name: e.name, bytes: st.size, mtime: st.mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, limit).map((f) => ({ ...f, mtime: new Date(f.mtime).toISOString() }));
}

export function inboxAbsPath(name) {
  return safeInboxName(name);
}

// Copy one file from the inbox (or, for re-promoting, anywhere already inside
// the confined project root) into `<relDir>/<destSub>/<filename>`. Returns the
// new path relative to ROOT.
export async function promoteMedia({ sourceAbsOrName, fromInbox, relDir, destSub, filename }) {
  const srcAbs = fromInbox ? safeInboxName(sourceAbsOrName) : safeResolve(sourceAbsOrName);
  const destAbs = safeResolve(relDir, destSub, filename);
  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  return relToRoot(await copyWithoutClobber(srcAbs, destAbs));
}

// The destination name is derived entirely from the asset (type/name/angle) or
// the beat (its role), so promoting a second image for the same subject lands
// on the same path. A bare copyFile overwrote a reference image that was
// already APPROVED, leaving the approval tick pointing at a frame nobody had
// reviewed and the reviewed file gone. Copy exclusively and number instead;
// the caller stores the path this returns, so nothing is lost either way.
export async function copyWithoutClobber(srcAbs, destAbs) {
  const ext = path.extname(destAbs);
  const base = destAbs.slice(0, destAbs.length - ext.length);
  for (let n = 1; n <= 999; n++) {
    const candidate = n === 1 ? destAbs : `${base}_${n}${ext}`;
    try {
      await fs.copyFile(srcAbs, candidate, fs.constants.COPYFILE_EXCL);
      return candidate;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
  throw new Error(`too many files already named like ${path.basename(destAbs)}`);
}

// Write bytes the browser sent (a real file picked via <input type=file> —
// the fix for "the picker should open a real file dialog") straight into the
// project, same non-clobbering discipline as promoteMedia's copy.
// Copy a file already inside the project into an episode subfolder,
// non-clobbering. Returns the new root-relative path.
export async function copyIntoEpisode({ sourceRel, relDir, destSub, filename }) {
  const srcAbs = safeResolve(sourceRel);
  const destAbs = safeResolve(relDir, destSub, filename || path.basename(srcAbs));
  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  return relToRoot(await copyWithoutClobber(srcAbs, destAbs));
}

export const absPath = (rel) => safeResolve(rel);

export async function saveUpload({ relDir, destSub, filename, buffer }) {
  const destAbs = safeResolve(relDir, destSub, filename);
  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  const ext = path.extname(destAbs);
  const base = destAbs.slice(0, destAbs.length - ext.length);
  for (let n = 1; n <= 999; n++) {
    const candidate = n === 1 ? destAbs : `${base}_${n}${ext}`;
    try {
      await fs.writeFile(candidate, buffer, { flag: "wx" });
      return relToRoot(candidate);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
  throw new Error(`too many files already named like ${path.basename(destAbs)}`);
}

// ---------- screenplay files ----------

// .fdx and .fountain are unambiguous screenplay formats — safe to pick up
// anywhere. .txt/.md are not (a series bible, a contract, and a script all
// use .md in this project), so those are only collected from a directory that
// is clearly script storage: 00_script/ or a folder literally named "Scripts".
const SCRIPT_STRICT_RX = /\.(fdx|fountain)$/i;
const SCRIPT_LOOSE_RX = /\.(fdx|fountain|txt|md)$/i;

async function scriptsIn(abs, label, out) {
  for (const f of await listFiles(abs)) {
    if (SCRIPT_LOOSE_RX.test(f) && !f.startsWith(".")) {
      out.push({ path: relToRoot(path.join(abs, f)), name: f, from: label });
    }
  }
}

// Look in the episode's own 00_script/ first, then its series folder (Man in
// the Glass keeps its scripts in a Scripts/ folder at the series level, one
// file covering all ten episodes), then the series folder itself.
export async function listScriptFiles(relDir, seriesDir) {
  const out = [];
  const tryRoot = async (rel, label) => {
    const abs = safeResolve(rel);
    // Loose top-level files: only the unambiguous formats.
    for (const f of await listFiles(abs)) {
      if (SCRIPT_STRICT_RX.test(f) && !f.startsWith(".")) {
        out.push({ path: relToRoot(path.join(abs, f)), name: f, from: label });
      }
    }
    for (const sub of await listDirs(abs)) {
      if (sub === "00_script" || /^scripts?$/i.test(sub)) {
        await scriptsIn(path.join(abs, sub), `${label}/${sub}`, out);
      }
    }
  };
  await tryRoot(relDir, "episode");
  if (seriesDir && seriesDir !== relDir) await tryRoot(seriesDir, "series");
  const seen = new Set();
  return out.filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)));
}

export async function readScriptFile(relPath) {
  return fs.readFile(safeResolve(relPath), "utf8");
}

// ---------- asset files ----------

// List real image files under an episode's 02_assets tree, so the Identity Vault
// can show pictures instead of the text labels v1 stored.
const IMG = /\.(png|jpe?g|webp|gif)$/i;
const VID = /\.(mp4|mov|webm|m4v)$/i;
const AUD = /\.(wav|mp3|m4a|aac|ogg)$/i;

export async function listAssetFiles(relDir) {
  const base = safeResolve(relDir, "02_assets");
  const out = [];
  const walk = async (dir, bucket) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, bucket || e.name);
      else if (IMG.test(e.name)) out.push({ path: relToRoot(p), name: e.name, bucket: bucket || "" });
    }
  };
  await walk(base, null);
  return out;
}

export async function listMediaFiles(relDir, sub) {
  const base = safeResolve(relDir, sub);
  const out = [];
  for (const e of await fs.readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith(".") || !e.isFile()) continue;
    if (!IMG.test(e.name) && !VID.test(e.name)) continue;
    const p = path.join(base, e.name);
    const st = await fs.stat(p);
    out.push({ path: relToRoot(p), name: e.name, bytes: st.size, kind: VID.test(e.name) ? "video" : "image" });
  }
  return out;
}

// Stills from EARLIER work on this series that the current episode can't see:
// an older episode's keyframes/ and 03_storyboard/, plus loose folders like
// Keyframes/ and Character images/. Walks the whole series folder except the
// current episode and every 02_assets/ (that's the asset library, reached
// through the Identity Vault instead). Byte-identical copies — the same image
// saved under a shot-coded name AND a descriptive one — collapse to one entry;
// file size is the identity key (comparing contents over the Drive mount would
// mean reading every file), and `also` keeps the other locations.
const EARLIER_SKIP = new Set(["02_assets", "04_video_prompts", "05_delivery"]);
export async function listEarlierMedia(seriesRelDir, episodeRelDir, kind = "image") {
  const want = kind === "video" ? VID : kind === "audio" ? AUD : IMG;
  const base = safeResolve(seriesRelDir);
  const skipAbs = safeResolve(episodeRelDir);
  const found = [];
  const walk = async (dir) => {
    const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of ents) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (p === skipAbs || (kind === "image" && EARLIER_SKIP.has(e.name))) continue;
        await walk(p);
      } else if (want.test(e.name)) {
        const st = await fs.stat(p);
        found.push({ path: relToRoot(p), name: e.name, folder: path.relative(base, dir) || ".", bytes: st.size });
      }
    }
  };
  await walk(base);
  // Keyframe folders win the dedupe, so the entry shown sits where the
  // episode work happened; the loose copies are listed under `also`.
  const rank = (f) => (/keyframes$|03_storyboard$/i.test(f.folder) ? 0 : 1);
  found.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
  const bySize = new Map();
  for (const f of found) {
    const key = `${f.bytes}:${path.extname(f.name).toLowerCase()}`;
    if (bySize.has(key)) bySize.get(key).also.push(f.path);
    else bySize.set(key, { ...f, also: [] });
  }
  return [...bySize.values()];
}

// "Find new images" in the Identity Vault: every image in any 02_assets/
// folder of the series (the shared _RedClover/02_assets/ and each episode's
// own) that this episode's vault doesn't use yet. Assets are spread across
// those folders until the planned tidy (BACKLOG), so the scan can't assume
// one place. A file whose size + extension matches a registered one is a copy
// of it and is left out (same identity key as listEarlierMedia). Nothing is
// linked here: Shawn picks each one in the UI. Replaces the September
// "Rescan 02_assets" button, whose handler had been deleted (found 2026-10-10).
const ASSET_SCAN_SKIP = new Set(["03_storyboard", "04_video_prompts", "05_delivery", "node_modules"]);
export async function listNewAssetImages(seriesRelDir, episodeRelDir, registeredPaths = []) {
  const base = safeResolve(seriesRelDir || episodeRelDir);
  const found = [];
  const collect = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await collect(p);
      else if (IMG.test(e.name)) {
        const st = await fs.stat(p);
        found.push({ path: relToRoot(p), name: e.name, folder: path.relative(base, dir) || ".", bytes: st.size });
      }
    }
  };
  const findAssetDirs = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || e.name.startsWith(".") || ASSET_SCAN_SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.name === "02_assets") await collect(p);
      else await findAssetDirs(p);
    }
  };
  await findAssetDirs(base);
  const registered = new Set(registeredPaths.filter(Boolean));
  const regKeys = new Set();
  for (const rel of registered) {
    const st = await fs.stat(safeResolve(rel)).catch(() => null);
    if (st) regKeys.add(`${st.size}:${path.extname(rel).toLowerCase()}`);
  }
  const seen = new Set();
  const out = [];
  for (const f of found.sort((a, b) => a.path.localeCompare(b.path))) {
    const key = `${f.bytes}:${path.extname(f.name).toLowerCase()}`;
    if (registered.has(f.path) || regKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

export { exists, readJSON, writeJSON, listDirs, listFiles };
