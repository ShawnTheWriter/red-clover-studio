// Red Clover Studio — local server.
// Binds to 127.0.0.1 only. API keys stay in this process and are never sent to
// the browser, which is the whole reason the v1 desk's browser-side key had to go.

import "./env.js"; // MUST be first — see env.js for why
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRouter, serve, sendJSON, sendFile } from "./http.js";
import * as store from "./store.js";
import { thumbnail } from "./thumbs.js";
import { probe } from "./ffprobe.js";
import { execFile } from "node:child_process";
import { shotPrompts, draftTimecodeText } from "../shared/prompts.js";
import { videoModelFor, removeAssetKeepRefs } from "../shared/schema.js";
import { LIPSYNC_MODELS, LIPSYNC_SYNC_MODES, UPSCALE_MODELS, UPSCALE_TARGETS } from "./rates.js";
import { parseTrimRequest } from "../shared/trim.js";
import { uid, newShot, newBeat, newAsset, normalizeTags, newScene, newEpisode, renumberScene, moveShotToScene, shiftSceneNumbers, reorderShot, reorderScenes, GATES, ASSET_TYPES, SCHEMA_VERSION } from "../shared/schema.js";
import { parseScreenplay, sliceEpisode } from "../shared/screenplay.js";
import { newAssetAudit, matchAssetImages } from "../shared/audit.js";
import { gateStatus, attemptGate, checkGate } from "../shared/gates.js";
import { newBlocking, episodeAxisWarnings } from "../shared/blocking.js";
import { VIDEO_MODELS, IMAGE_MODELS, effectiveVideoRate, effectiveImageRate, livePrice, liveRate } from "./rates.js";
import * as llm from "./llm.js";
import * as timeline from "./timeline.js";
import { buildFCPXML } from "./export/fcpxml.js";
import { buildOTIO } from "./export/otio.js";
import { buildEditSheet, orderedCopyPlan } from "./export/capcut.js";
import * as jobs from "./jobs.js";
import * as cut from "./cut.js";
import * as organize from "./organize.js";
import * as resolveScript from "./resolve-script.js";
import * as remaster from "./remaster.js";
import { hasLine } from "../shared/dialogue.js";
import * as voice from "./voice.js";
import * as providers from "./providers.js";
import * as pricewatch from "./pricewatch.js";
import * as roomtone from "./roomtone.js";
import * as soundcut from "./soundcut.js";
import * as sfx from "./sfx.js";
import { SUGGESTED_ROOT, SETTINGS_FILE, writeSettings } from "./settings.js";
import { SIZES, LENSES, ANGLES, MOVES, DELIVERY, TREATMENTS } from "../shared/grammar.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const WEB = path.join(REPO, "web");

const r = createRouter();

// Every episode write made from the UI goes through here, so each one can be
// undone (see store.withEpisode's history option).
const edit = (dir, fn) => store.withEpisode(dir, fn, { history: true });

// ---------- meta ----------

// First run / settings: the projects folder. Changing it needs the page's own
// header (like the key routes) so another website can't repoint the app.
r.get("/api/settings", () => ({ root: store.ROOT, rootFromEnv: store.ROOT_FROM_ENV, suggestedRoot: SUGGESTED_ROOT, settingsFile: SETTINGS_FILE, cheapestRoute: jobs.cheapestRouteOn() }));
// Cheapest route on/off (default on): send each take through whichever
// connected service sells that exact model for less (rates.js cheapestRoute).
r.post("/api/settings/cheapest-route", async ({ body, req }) => {
  requireUI(req);
  writeSettings({ cheapestRoute: body.on === false ? false : null });
  return { cheapestRoute: jobs.cheapestRouteOn() };
});
r.post("/api/settings/root", async ({ body, req }) => {
  requireUI(req);
  if (store.ROOT_FROM_ENV) throw Object.assign(new Error("RCS_PROJECT_ROOT is set for this server, so the folder can't be changed here."), { status: 409 });
  const root = await store.setRoot(body.path, { create: !!body.create });
  return { root };
});

// The sample project ships in <app>/sample/. Installing copies it into the
// user's projects folder (never over an existing series) and returns the
// episode to open. Free, local, no keys needed.
const SAMPLE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "sample");
r.get("/api/sample", async () => {
  const series = (await fs.readdir(SAMPLE_DIR, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => d.name);
  const installed = store.ROOT ? await Promise.all(series.map((s) => fs.access(path.join(store.ROOT, s)).then(() => true, () => false))) : [];
  return { available: series.length > 0, series: series[0] || null, installed: !!installed[0] };
});
r.post("/api/sample/install", async ({ req }) => {
  requireUI(req);
  const series = (await fs.readdir(SAMPLE_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)[0];
  if (!series) throw Object.assign(new Error("This copy of the app has no sample project."), { status: 404 });
  const dest = store.safeResolve(series);
  if (await fs.access(dest).then(() => true, () => false)) throw Object.assign(new Error(`"${series}" is already in your projects folder.`), { status: 409 });
  await fs.cp(path.join(SAMPLE_DIR, series), dest, { recursive: true, errorOnExist: true });
  const ep = (await fs.readdir(dest, { withFileTypes: true })).find((d) => d.isDirectory());
  return { seriesDir: series, dir: ep ? `${series}/${ep.name}` : null };
});

r.get("/api/health", () => ({
  ok: true,
  schemaVersion: SCHEMA_VERSION,
  root: store.ROOT,
  // Driver readiness, never the credentials themselves.
  drivers: jobs.driverStatus(),
  queue: jobs.queueDepth(),
}));

r.get("/api/grammar", () => ({
  sizes: SIZES, lenses: LENSES, angles: ANGLES, moves: MOVES,
  delivery: DELIVERY, treatments: TREATMENTS, gates: GATES, assetTypes: ASSET_TYPES,
  lipsyncModels: LIPSYNC_MODELS, lipsyncSyncModes: LIPSYNC_SYNC_MODES,
  upscaleModels: UPSCALE_MODELS, upscaleTargets: UPSCALE_TARGETS,
}));

r.get("/api/tree", () => store.scan());

// ---------- series ----------

r.get("/api/series", async ({ query }) => store.loadSeries(query.get("dir")));
r.put("/api/series", async ({ query, body }) => store.saveSeries(query.get("dir"), body));
r.get("/api/series/bible", async ({ query }) => ({
  dir: query.get("dir"),
  text: await store.readBible(query.get("dir")),
}));

// ---------- episodes ----------

r.get("/api/episode", async ({ query }) => store.loadEpisode(query.get("dir")));

// The browser holds a whole episode in memory and PUTs it back on every field
// edit, so what arrives here can be minutes stale. Merge it onto the CURRENT
// document under the write lock, and never let it carry the server's own
// bookkeeping backwards — the cost ledger, the generated takes, and every other
// collection with a dedicated route are owned here, not by the tab. Writing the
// body wholesale erased a finished job's ledger entry and reverted its take to
// "queued", which the next restart then re-submitted and paid for again.
const SERVER_OWNED_EPISODE_FIELDS = new Set([
  "ledger", "jobs", "shots", "assets", "scenes", "timeline", "exports",
  "dir", "schemaVersion", "updatedAt",
]);

r.put("/api/episode", async ({ query, body }) =>
  edit(query.get("dir"), (ep) => {
    for (const [k, v] of Object.entries(body || {})) {
      if (SERVER_OWNED_EPISODE_FIELDS.has(k)) continue;
      ep[k] = v;
    }
    return ep;
  }));

r.post("/api/episode/scaffold", async ({ body }) => ({ dir: await store.scaffold(body.dir) }));

r.post("/api/episode/create", async ({ body }) => {
  await store.scaffold(body.dir);
  const ep = newEpisode({
    name: body.name || path.basename(body.dir),
    dir: body.dir,
    seriesId: body.seriesId || null,
    number: body.number ?? null,
    fmt: body.fmt || "9:16",
    style: body.style || "",
    ban: body.ban || "",
  });
  return store.saveEpisode(body.dir, ep);
});

// New project from the Library: a series folder (with series.json, so the
// vault registry and Missing work) and its first episode, in one step.
// Refuses to touch an episode folder that already has a studio.json.
r.post("/api/project/create", async ({ body }) => {
  const clean = (s) => String(s || "").trim().replace(/[\/\\:*?"<>|]+/g, "-").replace(/\s+/g, " ").slice(0, 80);
  const series = clean(body.series), episode = clean(body.episode) || "Episode 1";
  if (!series) throw Object.assign(new Error("give the series a name"), { status: 400 });
  const dir = `${series}/${episode}`;
  const exists = await fs.access(path.join(store.safeResolve(dir), "studio.json")).then(() => true, () => false);
  if (exists) throw Object.assign(new Error(`"${dir}" already exists — open it from the Library`), { status: 409 });
  await fs.mkdir(path.join(store.safeResolve(series), "Scripts"), { recursive: true });
  const s = await store.loadSeries(series);
  await store.saveSeries(series, s);
  await store.scaffold(dir);
  // A new episode of an existing series starts from the series defaults;
  // its vault comes from the series automatically (store.loadEpisode).
  const fmt = body.fmt === "16:9" || body.fmt === "9:16" ? body.fmt : (s.fmt || "9:16");
  const ep = newEpisode({ name: `${series} — ${episode}`, dir, seriesId: s.id || null, fmt, style: body.style || s.style || "", ban: s.ban || "", defaultVideoModelId: s.defaultVideoModelId || null });
  await store.saveEpisode(dir, ep);
  return { dir, seriesDir: series };
});

// ---------- v1 migration ----------

r.get("/api/migrate/scan", async ({ query }) => ({
  dir: query.get("dir"),
  exports: await store.findV1Exports(query.get("dir")),
}));

r.post("/api/migrate/import", async ({ body }) =>
  store.importV1(body.dir, body.file, {
    seriesId: body.seriesId || null,
    name: body.name,
    number: body.number,
    productionName: body.productionName,
  }));

// ---------- shots ----------

// Prompts are built server-side so the wording has exactly one home. The browser
// renders strings it is handed; it never re-implements a prompt.
function promptStyleFor(shot, ep) {
  const id = videoModelFor(shot, ep, VIDEO_MODELS.map((m) => m.id));
  const m = VIDEO_MODELS.find((x) => x.id === id);
  return (m && m.promptStyle) || null;
}

r.get("/api/episode/prompts", async ({ query }) => {
  const ep = await store.loadEpisode(query.get("dir"));
  const shotId = query.get("shot");
  const shots = shotId ? ep.shots.filter((s) => s.id === shotId) : ep.shots;
  return {
    dir: ep.dir,
    // The prompt shown is the one the shot's current model will get (H3 Max
    // gets fal's brief shape) — same resolver the job queue uses.
    shots: shots.map((s) => ({ id: s.id, label: s.label, ...shotPrompts(s, ep, { style: promptStyleFor(s, ep) }) })),
  };
});

r.post("/api/episode/timecode/draft", async ({ body }) => {
  const ep = await store.loadEpisode(body.dir);
  const shot = ep.shots.find((s) => s.id === body.shotId);
  if (!shot) throw Object.assign(new Error("shot not found"), { status: 404 });
  return { text: draftTimecodeText(shot, ep) };
});

// Inserts a shot at `index` (default: end of the array) and relabels every
// shot in its scene so the lettering matches the new sequence — a shot
// dropped in "after 3a" becomes 3b, and whatever was 3b becomes 3c, rather
// than colliding on the same code or leaving a gap.
r.post("/api/episode/shot", async ({ body }) =>
  edit(body.dir, (ep) => {
    const shot = newShot(body.shot || {});
    const at = body.index ?? ep.shots.length;
    ep.shots.splice(at, 0, shot);
    renumberScene(ep.shots, shot.sceneNum);
    return shot;
  }));

r.post("/api/episode/beat", async ({ body }) =>
  edit(body.dir, (ep) => {
    const shot = ep.shots.find((s) => s.id === body.shotId);
    if (!shot) throw Object.assign(new Error("shot not found"), { status: 404 });
    const beat = newBeat(body.beat || {});
    const at = body.index ?? shot.beats.length;
    shot.beats.splice(at, 0, beat);
    return beat;
  }));

// A beat's frame name/number is always DERIVED (beatFrameName in
// shared/grammar.js, computed from the beat's live position + role), never
// stored — so unlike shots, deleting or inserting a beat needs no separate
// renumber pass; the next prompts/board read already reflects the new order.
// A shot needs at least one beat (newShot always seeds one), so the last
// beat can't be deleted — only replaced by editing it or deleting the shot.
r.post("/api/episode/beat/delete", async ({ body }) =>
  edit(body.dir, (ep) => {
    const shot = ep.shots.find((s) => s.id === body.shotId);
    if (!shot) throw Object.assign(new Error("shot not found"), { status: 404 });
    if (shot.beats.length <= 1) {
      throw Object.assign(new Error("can't delete the last beat on a shot — delete the shot instead, or add a replacement beat first"), { status: 400 });
    }
    shot.beats = shot.beats.filter((b) => b.id !== body.beatId);
    return { shotId: shot.id, beats: shot.beats.length };
  }));

// ---------- development: screenplay ingestion ----------

r.get("/api/screenplay/files", async ({ query }) => ({
  files: await store.listScriptFiles(query.get("dir"), query.get("seriesDir") || null),
}));

// Parse a script file without saving anything. For a combined multi-episode
// .fdx (Man in the Glass ships all ten in one file), pass `episode` to slice
// one out; omit it to get the whole document's episode boundaries back so the
// UI can offer a picker.
r.get("/api/screenplay/parse", async ({ query }) => {
  const relPath = query.get("path");
  const text = await store.readScriptFile(relPath);
  const parsed = parseScreenplay(text, relPath);
  const epNum = query.get("episode");
  if (epNum) {
    const sliced = sliceEpisode(parsed, Number(epNum));
    if (!sliced) throw Object.assign(new Error(`episode ${epNum} not found in this file`), { status: 404 });
    return { path: relPath, single: false, episodes: parsed.episodes.map((e) => e.number), slice: sliced };
  }
  // Single-episode file (Fashion Heist's per-episode .fdx): episodes.length <= 1.
  if (parsed.episodes.length <= 1) {
    return { path: relPath, single: true, ...parsed };
  }
  return { path: relPath, single: false, episodes: parsed.episodes.map((e) => e.number), scenes: parsed.scenes.length };
});

// Import parsed scenes into an episode workspace. Replaces ep.scenes wholesale
// — re-parsing is expected to be the correction workflow, not per-scene edits
// against machine output.
r.post("/api/episode/scenes/import", async ({ body }) =>
  edit(body.dir, (ep) => {
    ep.scenes = (body.scenes || []).map((s) => newScene(s));
    ep.scriptPath = body.scriptPath || ep.scriptPath;
    return { dir: ep.dir, scenes: ep.scenes };
  }));

// Renumber scene `fromSceneNum` and everything after it by `delta` — "this
// scene and later were all off by one" (after retiring an empty scene, or to
// open a slot for a new one mid-episode). See shiftSceneNumbers for the
// collision rule (shifting down refuses if it would overwrite scene content
// that wasn't part of the request).
r.post("/api/episode/scenes/shift", async ({ body }) =>
  edit(body.dir, (ep) => shiftSceneNumbers(ep, body.fromSceneNum, body.delta)));

// Draft one shot skeleton per scene — replaces v1's slugline-splitting
// heuristic with real parsed scene data. This is a starting skeleton, not a
// finished shot list: shot-grammar.md is explicit that decomposing a scene
// into atomic shots is editorial work, not parsing.
r.post("/api/episode/shots/draft-from-scenes", async ({ body }) =>
  edit(body.dir, (ep) => {
  const existingCodes = new Set(ep.shots.map((s) => `${s.sceneNum}${s.shotCode}`));
  let added = 0;
  for (const scene of ep.scenes) {
    const code = `${scene.number}a`;
    if (existingCodes.has(code) && !body.force) continue;
    ep.shots.push(newShot({
      sceneNum: scene.number,
      shotCode: "a",
      intext: scene.intext,
      loc: scene.loc,
      time: scene.time,
      label: scene.synopsis ? scene.synopsis.slice(0, 60) : "",
      action: scene.synopsis || "",
      location: scene.loc,
    }));
    added += 1;
  }
  return { dir: ep.dir, added, totalShots: ep.shots.length };
  }));

// ---------- undo ----------

r.post("/api/episode/undo", async ({ body }) => store.undoEpisode(body.dir));
r.get("/api/episode/history", async ({ query }) => ({ depth: await store.historyDepth(query.get("dir")) }));

// ---------- development: gates & new-asset audit ----------

r.get("/api/episode/audit", async ({ query }) => {
  const ep = await store.loadEpisode(query.get("dir"));
  const seriesDir = query.get("seriesDir");
  const series = seriesDir ? await store.loadSeries(seriesDir) : null;
  const registry = series ? series.registry.filter((a) => a.approved) : [];
  const audit = newAssetAudit(ep.scenes || [], registry);
  for (const row of audit.new) row.matches = matchAssetImages(row, ep.assets);
  // So the client can offer "link as alias to an existing registry asset"
  // instead of only Waive/Add to registry — id/name/aliases is all it needs,
  // scoped per row's type on the client.
  const registrySlim = registry.map((a) => ({ id: a.id, type: a.type, name: a.name, aliases: a.aliases || [] }));
  return { dir: ep.dir, registrySize: registry.length, registry: registrySlim, ...audit };
});

r.post("/api/episode/audit/override", async ({ body }) =>
  edit(body.dir, (ep) => {
    const key = `${body.assetType}:${(body.name || "").trim().toLowerCase().replace(/\s+/g, " ")}`;
    if (body.clear) delete ep.assetAuditOverrides[key];
    else ep.assetAuditOverrides[key] = body.resolution || "waived";
    return { dir: ep.dir, overrides: ep.assetAuditOverrides };
  }));

r.get("/api/episode/gates", async ({ query }) => {
  const ep = await store.loadEpisode(query.get("dir"));
  const seriesDir = query.get("seriesDir");
  const series = seriesDir ? await store.loadSeries(seriesDir) : null;
  const registry = series ? series.registry.filter((a) => a.approved) : [];
  return { dir: ep.dir, current: ep.gate, gates: gateStatus(ep, registry) };
});

r.post("/api/episode/gate", async ({ body }) =>
  edit(body.dir, async (ep) => {
    const seriesDir = body.seriesDir;
    const series = seriesDir ? await store.loadSeries(seriesDir) : null;
    const registry = series ? series.registry.filter((a) => a.approved) : [];
    const result = attemptGate(ep, registry, body.gate, body.note);
    return { dir: ep.dir, current: ep.gate, ...result };
  }));

// Promote a new-asset-audit "new" row into the series registry, so the next
// audit run sees it as standing. Building the actual reference image is
// Phase 2 (Identity Vault); this just registers the placeholder so the gate
// can track it.
r.post("/api/series/registry/add", async ({ body }) => {
  const series = await store.loadSeries(body.seriesDir);
  const asset = newAsset({ type: body.assetType, name: body.name, seriesCanon: true, approved: !!body.approved });
  series.registry.push(asset);
  await store.saveSeries(body.seriesDir, series);
  return asset;
});

// Link a new-asset-audit row's script name to an EXISTING registry asset as
// an alias, instead of creating a duplicate ("Serge" -> "Serge Stitch") —
// series-wide and permanent, so every episode's audit (not just this one)
// counts it as standing from now on.
r.post("/api/series/registry/alias", async ({ body }) => {
  const series = await store.loadSeries(body.seriesDir);
  const asset = series.registry.find((a) => a.id === body.assetId);
  if (!asset) throw Object.assign(new Error("registry asset not found"), { status: 404 });
  const alias = (body.alias || "").trim();
  if (!alias) throw Object.assign(new Error("alias can't be empty"), { status: 400 });
  asset.aliases = asset.aliases || [];
  if (!asset.aliases.some((a) => a.trim().toLowerCase() === alias.toLowerCase())) asset.aliases.push(alias);
  await store.saveSeries(body.seriesDir, series);
  return asset;
});

// ---------- assets ----------

r.get("/api/episode/assetfiles", async ({ query }) => ({
  files: await store.listAssetFiles(query.get("dir")),
}));

// Identity Vault "Find new images": asset-folder images the vault doesn't use
// yet, across the whole series (see store.listNewAssetImages). Read-only.
r.get("/api/episode/new-asset-images", async ({ query }) => {
  const dir = query.get("dir");
  const ep = await store.loadEpisode(dir);
  return { files: await store.listNewAssetImages(query.get("seriesDir"), dir, (ep.assets || []).map((a) => a.path)) };
});

// Every image this episode already has on disk — 02_assets/ (recursive) plus
// 03_storyboard/ — in one list, for a picker that searches this project
// instead of defaulting to whatever's newest in the cross-project inbox.
r.get("/api/episode/project-media", async ({ query }) => {
  const dir = query.get("dir");
  const [assetFiles, boardFiles] = await Promise.all([
    store.listAssetFiles(dir),
    store.listMediaFiles(dir, "03_storyboard"),
  ]);
  const files = [
    ...assetFiles.map((f) => ({ path: f.path, name: f.name, kind: "image", source: `02_assets/${f.bucket || ""}` })),
    ...boardFiles.map((f) => ({ path: f.path, name: f.name, kind: f.kind, source: "03_storyboard" })),
  ];
  return { dir, files };
});

r.get("/api/episode/media", async ({ query }) => ({
  files: await store.listMediaFiles(query.get("dir"), query.get("sub") || "03_storyboard"),
}));

r.post("/api/episode/asset", async ({ body }) =>
  edit(body.dir, async (ep) => {
    const asset = newAsset(body.asset || {});
    // A series card: saved to the series vault (store.saveEpisode syncs it),
    // seen by every episode of the series.
    if (body.asset && body.asset.fromSeries) {
      if (!(await store.seriesDirOf(body.dir))) throw Object.assign(new Error("this episode isn't inside a series folder"), { status: 400 });
      Object.assign(asset, { fromSeries: true, vault: true, seriesCanon: true, approved: true });
    }
    ep.assets.push(asset);
    return asset;
  }));

// Move episode cards (every angle of a card) up into the series vault. Images
// are copied into <Series>/_RedClover/02_assets/<type>s/ so they don't depend
// on this episode's folder. A matching name-only placeholder in the registry
// is replaced, its aliases kept. Asset ids are kept, so shot references hold.
r.post("/api/episode/asset/promote", async ({ body }) =>
  edit(body.dir, async (ep) => {
    const sd = await store.seriesDirOf(body.dir);
    if (!sd) throw Object.assign(new Error("this episode isn't inside a series folder"), { status: 400 });
    const ids = new Set(body.assetIds || []);
    const cards = (ep.assets || []).filter((a) => ids.has(a.id) && !a.fromSeries);
    const series = await store.loadSeries(sd);
    for (const a of cards) {
      if (a.path && !a.path.startsWith(`${sd}/_RedClover/`)) {
        const dest = store.safeResolve(sd, "_RedClover", "02_assets", `${a.type}s`, path.basename(a.path));
        await fs.mkdir(path.dirname(dest), { recursive: true });
        a.path = store.relToRoot(await store.copyWithoutClobber(store.safeResolve(a.path), dest));
      }
      const key = (n) => String(n || "").trim().toLowerCase();
      const ph = series.registry.filter((r) => !r.vault && r.type === a.type && (key(r.name) === key(a.name) || (r.aliases || []).some((x) => key(x) === key(a.name))));
      a.aliases = [...new Set([...(a.aliases || []), ...ph.flatMap((r) => [r.name, ...(r.aliases || [])]).filter((n) => key(n) !== key(a.name))])];
      series.registry = series.registry.filter((r) => !ph.includes(r));
      Object.assign(a, { fromSeries: true, vault: true, seriesCanon: true, approved: true });
    }
    await store.saveSeries(sd, series);
    return { promoted: cards.length };
  }));

// Take cards out of the series vault and keep them in this episode only. The
// registry keeps a name-only placeholder so Missing still counts the name.
r.post("/api/episode/asset/demote", async ({ body }) =>
  edit(body.dir, async (ep) => {
    const sd = await store.seriesDirOf(body.dir);
    if (!sd) throw Object.assign(new Error("this episode isn't inside a series folder"), { status: 400 });
    const ids = new Set(body.assetIds || []);
    const series = await store.loadSeries(sd);
    let n = 0;
    for (const a of (ep.assets || []).filter((x) => ids.has(x.id) && x.fromSeries)) {
      delete a.fromSeries; a.vault = false; n++;
      const i = series.registry.findIndex((r) => r.id === a.id);
      if (i >= 0) series.registry[i] = { id: a.id, type: a.type, name: a.name, aliases: a.aliases || [], approved: true, seriesCanon: true };
    }
    await store.saveSeries(sd, series);
    return { demoted: n };
  }));

// Series defaults new episodes start from (format, style, ban list, model).
r.post("/api/series/defaults", async ({ body }) => {
  const series = await store.loadSeries(body.seriesDir);
  for (const k of ["fmt", "style", "ban", "defaultVideoModelId"]) if (body[k] !== undefined) series[k] = body[k];
  await store.saveSeries(body.seriesDir, series);
  return { fmt: series.fmt, style: series.style, ban: series.ban, defaultVideoModelId: series.defaultVideoModelId || null };
});

// ---------- shot / beat / asset mutation ----------

r.post("/api/episode/shot/update", async ({ body }) =>
  edit(body.dir, (ep) => {
    const shot = ep.shots.find((s) => s.id === body.shotId);
    if (!shot) throw Object.assign(new Error("shot not found"), { status: 404 });
    // Never let a shot patch carry the job queue's own fields backwards.
    const patch = { ...(body.patch || {}) };
    delete patch.versions;
    Object.assign(shot, patch);
    return shot;
  }));

r.post("/api/episode/shot/delete", async ({ body }) =>
  edit(body.dir, (ep) => {
    const removed = ep.shots.find((s) => s.id === body.shotId);
    ep.shots = ep.shots.filter((s) => s.id !== body.shotId);
    // Renumbering after a delete is what closes the gap it would otherwise
    // leave (3a, [3b deleted], 3c → 3a, 3b) — the whole point of the request,
    // not just parity with the insert path.
    if (removed) renumberScene(ep.shots, removed.sceneNum);
    return { dir: ep.dir, shots: ep.shots.length };
  }));

// Move one storyboard (beat) to another shot in the same scene, or out into a
// brand-new shot right after its current one ("make 2b end its own shot 2c").
// Placement in the target follows the frame's role: start first, end last,
// mid just before any end. A moved-in frame becomes the new shot's "start".
// A shot left with no beats is removed — everything in it has moved.
r.post("/api/episode/beat/move", async ({ body }) =>
  edit(body.dir, (ep) => {
    const from = ep.shots.find((s) => s.id === body.shotId);
    if (!from) throw Object.assign(new Error("shot not found"), { status: 404 });
    const beat = from.beats.find((b) => b.id === body.beatId);
    if (!beat) throw Object.assign(new Error("storyboard not found"), { status: 404 });

    let to;
    if (body.newShot) {
      to = newShot({
        sceneId: from.sceneId, sceneNum: from.sceneNum, intext: from.intext, loc: from.loc, time: from.time,
        location: from.location, size: from.size, angle: from.angle, lens: from.lens, move: from.move,
        lighting: from.lighting, subjects: from.subjects, refs: [...(from.refs || [])],
        label: body.label || "",
      });
      to.beats = []; // newShot seeds a blank start frame; the moved one replaces it
      ep.shots.splice(ep.shots.indexOf(from) + 1, 0, to);
      beat.role = "start";
    } else {
      to = ep.shots.find((s) => s.id === body.toShotId);
      if (!to) throw Object.assign(new Error("target shot not found"), { status: 404 });
      if (to === from) return { shotId: to.id };
      if (to.sceneNum !== from.sceneNum) throw Object.assign(new Error("can only move a storyboard within its scene"), { status: 400 });
    }

    from.beats = from.beats.filter((b) => b !== beat);
    if (!body.newShot) {
      const endAt = to.beats.findIndex((b) => b.role === "end");
      if (beat.role === "start") to.beats.unshift(beat);
      else if (beat.role === "end" && endAt >= 0) { beat.role = "mid"; to.beats.splice(endAt, 0, beat); }
      else if (beat.role === "mid" && endAt >= 0) to.beats.splice(endAt, 0, beat);
      else to.beats.push(beat);
    } else {
      to.beats.push(beat);
    }
    if (!from.beats.length) ep.shots = ep.shots.filter((s) => s !== from);
    renumberScene(ep.shots, from.sceneNum);
    return { shotId: to.id, shotCode: `${to.sceneNum}${to.shotCode}`, sourceRemoved: !from.beats.length };
  }));

// Move a shot one place up or down WITHIN its scene. Shot letters are derived
// from position, so this is how a shot's number changes.
r.post("/api/episode/shot/move", async ({ body }) =>
  edit(body.dir, (ep) => {
    const i = ep.shots.findIndex((s) => s.id === body.shotId);
    if (i < 0) throw Object.assign(new Error("shot not found"), { status: 404 });
    const j = i + (body.by < 0 ? -1 : 1);
    if (j < 0 || j >= ep.shots.length || ep.shots[j].sceneNum !== ep.shots[i].sceneNum) {
      throw Object.assign(new Error("already at the edge of the scene"), { status: 400 });
    }
    [ep.shots[i], ep.shots[j]] = [ep.shots[j], ep.shots[i]];
    renumberScene(ep.shots, ep.shots[j].sceneNum);
    return { ok: true };
  }));

// Move a shot into a DIFFERENT scene — for a shot that was drafted under the
// wrong scene number (or an insert that turns out to belong inside an
// existing scene rather than starting its own). shot/move above only
// reorders within one scene; this is the cross-scene counterpart.
// Drag-and-drop reorders (one edit, one undo step each).
r.post("/api/episode/shot/reorder", async ({ body }) =>
  edit(body.dir, (ep) => reorderShot(ep, body.shotId, body.beforeShotId || null)));
r.post("/api/episode/scenes/reorder", async ({ body }) =>
  edit(body.dir, (ep) => reorderScenes(ep, body.order, organize.CUT_SCENE)));

r.post("/api/episode/shot/move-to-scene", async ({ body }) =>
  edit(body.dir, async (ep) => {
    const before = ep.shots.find((s) => s.id === body.shotId);
    const fromCode = before ? `${before.sceneNum}${before.shotCode}` : "";
    const shot = moveShotToScene(ep, body.shotId, body.targetSceneNum, body.position);
    // Into the bin by hand ("Archive (not in the edit)"): marked like a shot the
    // Resolve organize step cut, so the timeline, exports, sound and gates skip
    // it. Moving a shot out of the bin restores it.
    if (shot.sceneNum === organize.CUT_SCENE) {
      if (!shot.cutFromEdit) shot.cutFromEdit = { at: new Date().toISOString(), fromCode, manual: true };
    } else delete shot.cutFromEdit;
    // A built timeline follows at once, so the next FCPXML matches the board.
    const built = ((ep.timeline && ep.timeline.tracks) || []).some((t) => (t.clips || []).length);
    if (built) await timeline.rebuildFromSelection(ep);
    return { shotId: shot.id, sceneNum: shot.sceneNum, shotCode: shot.shotCode, rebuilt: built };
  }));

r.post("/api/episode/beat/update", async ({ body }) =>
  edit(body.dir, (ep) => {
    const shot = ep.shots.find((s) => s.id === body.shotId);
    if (!shot) throw Object.assign(new Error("shot not found"), { status: 404 });
    const beat = shot.beats.find((b) => b.id === body.beatId);
    if (!beat) throw Object.assign(new Error("beat not found"), { status: 404 });
    Object.assign(beat, body.patch || {});
    return beat;
  }));

// Generate a board still in-session: builds the same prompt shown in the
// shot's Nano Banana prompt box, auto-attaches the shot's own reference
// assets (shot.refs) as omni-reference images, and writes the result into
// this episode's own 03_storyboard/ — never the shared generated_imgs/ inbox.
r.post("/api/episode/beat/generate-still", async ({ body }) =>
  jobs.generateStill({ dir: body.dir, shotId: body.shotId, beatId: body.beatId, modelId: body.modelId }));

// Conversational follow-up on the beat's existing still — feeds the previous
// generation back in as the anchor reference plus a text instruction, the
// same move as typing a correction back to ChatGPT.
r.post("/api/episode/beat/refine-still", async ({ body }) =>
  jobs.refineStill({ dir: body.dir, shotId: body.shotId, beatId: body.beatId, instruction: body.instruction, modelId: body.modelId }));

// Attach or update a board frame on a keyframe beat. This is what feeds gate
// G3 — beatStillStats() in shared/gates.js counts approved frames directly.
r.post("/api/episode/beat/frame", async ({ body }) =>
  edit(body.dir, (ep) => {
    const shot = ep.shots.find((s) => s.id === body.shotId);
    if (!shot) throw Object.assign(new Error("shot not found"), { status: 404 });
    const beat = shot.beats.find((b) => b.id === body.beatId);
    if (!beat) throw Object.assign(new Error("beat not found"), { status: 404 });
    beat.frame = {
      path: body.path ?? (beat.frame && beat.frame.path) ?? null,
      approved: body.approved ?? (beat.frame && beat.frame.approved) ?? false,
      generatedAt: (beat.frame && beat.frame.generatedAt) || new Date().toISOString(),
      driver: body.driver || (beat.frame && beat.frame.driver) || "manual",
      model: body.model || (beat.frame && beat.frame.model) || "nano-banana",
    };
    return { shotId: shot.id, beatId: beat.id, frame: beat.frame };
  }));

r.post("/api/episode/asset/update", async ({ body }) =>
  edit(body.dir, (ep) => {
    const asset = ep.assets.find((a) => a.id === body.assetId);
    if (!asset) throw Object.assign(new Error("asset not found"), { status: 404 });
    Object.assign(asset, body.patch || {});
    return asset;
  }));

// Re-file one or more assets (all angles of a card) in a single edit() so the
// move is ONE undo step. Only `type` and `tags` can change here.
r.post("/api/episode/asset/organize", async ({ body }) =>
  edit(body.dir, (ep) => {
    const ids = new Set(Array.isArray(body.assetIds) ? body.assetIds : []);
    const patch = body.patch || {};
    if (patch.type !== undefined && !ASSET_TYPES.includes(patch.type))
      throw Object.assign(new Error(`type must be one of ${ASSET_TYPES.join(", ")}`), { status: 400 });
    const hit = ep.assets.filter((a) => ids.has(a.id));
    if (!hit.length) throw Object.assign(new Error("asset not found"), { status: 404 });
    for (const a of hit) {
      if (patch.type !== undefined) a.type = patch.type;
      if (patch.tags !== undefined) a.tags = normalizeTags(patch.tags);
    }
    return { moved: hit.length };
  }));

// Deleting one angle of a multi-angle card (e.g. an empty slot left beside
// the real image, 2026-10-10) must not drop the card from shots that point at
// that angle's id: their refs move to a remaining angle of the same card.
r.post("/api/episode/asset/delete", async ({ body }) =>
  edit(body.dir, (ep) => {
    const target = (ep.assets || []).find((a) => a.id === body.assetId);
    if (target && target.fromSeries) throw Object.assign(new Error("This card belongs to the series (every episode uses it). Make it episode-only first, then delete it here."), { status: 409 });
    const heir = removeAssetKeepRefs(ep, body.assetId);
    return { dir: ep.dir, assets: ep.assets.length, refsMovedTo: heir ? heir.id : null };
  }));

// ---------- pre-production: blocking & the 180 check ----------

r.get("/api/episode/continuity", async ({ query }) => {
  const ep = await store.loadEpisode(query.get("dir"));
  return { dir: ep.dir, warnings: episodeAxisWarnings(ep.shots || []) };
});

// ---------- generated-images inbox ----------

r.get("/api/generated/list", async () => ({
  root: store.GENERATED_ROOT,
  files: await store.listGeneratedImages(),
}));

r.get("/media-inbox", async ({ query, req, res }) => {
  const name = query.get("name");
  if (!name) return sendJSON(res, 400, { error: "missing ?name=" });
  const abs = store.inboxAbsPath(name);
  const w = Number(query.get("w") || 0);
  if (w > 0) {
    const t = await thumbnail(abs, Math.min(w, 2048));
    if (t) return sendFile(res, t, req);
  }
  return sendFile(res, abs, req);
});

// Copy a file (from the inbox, or already inside the project) into a
// scaffold subfolder and hand back the new project-relative path. Callers
// (Identity Vault promote, board frame promote) then attach that path to an
// asset or a beat in a second call — this route only ever copies a file.
r.get("/api/episode/earlier-media", async ({ query }) => {
  const seriesDir = query.get("seriesDir");
  if (!seriesDir) return { files: [] }; // a standalone episode has no earlier siblings
  return { files: await store.listEarlierMedia(seriesDir, query.get("dir"), query.get("kind") || "image") };
});

// ---------- importing clips you already have ----------
//
// A clip made elsewhere — a collaborator's render, another machine, an older
// cut — goes into the shot's takes like a generated one, but free and with no
// G3 requirement: the board gate exists to stop PAID generation before boards
// are approved, and nothing is being generated here. Always copied into the
// episode's own takes folder so the episode stays self-contained.
const IMPORT_SUB = "05_delivery/takes/imported";

async function addImportedTake(dir, shotId, relPath, { label, from }) {
  const meta = await probe(store.absPath(relPath)); // throws if it isn't a readable video
  return edit(dir, (ep) => {
    const shot = ep.shots.find((s) => s.id === shotId);
    if (!shot) throw Object.assign(new Error("shot not found"), { status: 404 });
    const now = new Date().toISOString();
    const v = {
      id: uid(),
      shotId: shot.id, modelId: "import", modelLabel: label || path.basename(relPath),
      driver: "import", seconds: String(Math.round(meta.durationSec * 10) / 10),
      keyframePath: null, billable: false, estimateUSD: 0, quotedUSD: 0, estimateConfidence: null, actualUSD: 0,
      state: "done", error: null, jobId: null, path: relPath,
      submittedAt: now, finishedAt: now, elapsedMs: null,
      importedFrom: from || null,
    };
    shot.versions = shot.versions || [];
    shot.versions.push(v);
    if (!(shot.selectedVersions || []).length) shot.selectedVersions = [v.id];
    return v;
  });
}

r.post("/api/episode/take/import", async ({ body }) => {
  const copied = await store.copyIntoEpisode({ sourceRel: body.source, relDir: body.dir, destSub: IMPORT_SUB });
  return addImportedTake(body.dir, body.shotId, copied, { label: body.label, from: body.source });
});

// Raw bytes from the browser's file dialog (see http.readBody's raw mode).
r.post("/api/episode/take/upload", async ({ query, body }) => {
  if (!body || !body.raw || !body.raw.length) throw Object.assign(new Error("no file data in upload"), { status: 400 });
  const filename = path.basename(query.get("filename") || `clip_${Date.now()}.mp4`);
  const saved = await store.saveUpload({ relDir: query.get("dir"), destSub: IMPORT_SUB, filename, buffer: body.raw });
  return addImportedTake(query.get("dir"), query.get("shotId"), saved, { label: query.get("label"), from: `uploaded: ${filename}` });
});

// ---------- reference video (motion references) ----------
//
// Blender previs, grey-box or rehearsal clips on a shot. Stored in the
// episode's 02_assets/reference_video/, measured on arrival (the models have
// per-clip and combined length limits), and sent only when switched on and
// the chosen model takes reference video (rates.js refVideo).
r.post("/api/episode/refvideo/upload", async ({ query, body }) => {
  if (!body || !body.raw || !body.raw.length) throw Object.assign(new Error("no file data in upload"), { status: 400 });
  const dir = query.get("dir");
  const filename = path.basename(query.get("filename") || `reference_${Date.now()}.mp4`);
  if (!/\.(mp4|mov|m4v)$/i.test(filename)) throw Object.assign(new Error("reference videos must be .mp4 or .mov"), { status: 400 });
  const saved = await store.saveUpload({ relDir: dir, destSub: "02_assets/reference_video", filename, buffer: body.raw });
  let seconds = null, width = null, height = null, fps = null;
  try { const pr = await probe(store.safeResolve(saved)); seconds = pr.durationSec ?? null; width = pr.width ?? null; height = pr.height ?? null; fps = pr.fps ?? null; } catch { /* unmeasured: still usable, limits unchecked */ }
  return edit(dir, (ep) => {
    const shot = ep.shots.find((s) => s.id === query.get("shotId"));
    if (!shot) throw Object.assign(new Error("shot not found"), { status: 404 });
    const v = { id: uid(), path: saved, label: (query.get("label") || filename.replace(/\.[^.]+$/, "")).slice(0, 80), seconds, width, height, fps, use: true, addedAt: new Date().toISOString() };
    shot.refVideos = [...(shot.refVideos || []), v];
    return v;
  });
});

r.post("/api/episode/refvideo/update", async ({ body }) =>
  edit(body.dir, (ep) => {
    const shot = ep.shots.find((s) => s.id === body.shotId);
    const v = shot && (shot.refVideos || []).find((x) => x.id === body.id);
    if (!v) throw Object.assign(new Error("reference video not found"), { status: 404 });
    const patch = body.patch || {};
    if (patch.use !== undefined) v.use = !!patch.use;
    if (patch.label !== undefined) v.label = String(patch.label).slice(0, 80);
    return v;
  }));

// Removes it from the shot; the file stays in 02_assets/reference_video/.
r.post("/api/episode/refvideo/remove", async ({ body }) =>
  edit(body.dir, (ep) => {
    const shot = ep.shots.find((s) => s.id === body.shotId);
    if (!shot) throw Object.assign(new Error("shot not found"), { status: 404 });
    shot.refVideos = (shot.refVideos || []).filter((x) => x.id !== body.id);
    return { removed: true };
  }));

// ---------- dialogue audio + lip sync ----------
//
// Recorded dialogue (ElevenLabs downloads, a collaborator's session) attaches to
// a SHOT as an audio clip — free, editorial, no gate, and it follows Undo like
// an imported clip. It is copied into the episode so the episode stays
// self-contained. A clip does nothing by itself; lip sync reads it.
const AUDIO_SUB = "05_delivery/audio/dialogue";
const AUDIO_EXT = /\.(wav|mp3|m4a|aac|ogg)$/i;

async function addAudioClip(dir, shotId, relPath, { label, from, beatId, kind }) {
  if (!AUDIO_EXT.test(relPath)) throw Object.assign(new Error("audio must be .wav, .mp3, .m4a, .aac or .ogg"), { status: 400 });
  const meta = await probe(store.absPath(relPath)); // throws if it isn't readable media
  return edit(dir, (ep) => {
    const shot = ep.shots.find((s) => s.id === shotId);
    if (!shot) throw Object.assign(new Error("shot not found"), { status: 404 });
    const clip = {
      id: uid(), label: (label || path.basename(relPath)).trim(), path: relPath,
      seconds: Math.round(meta.durationSec * 10) / 10,
      importedFrom: from || null, addedAt: new Date().toISOString(),
      // Which line this recording is for (Dialogue lane), and whether it is
      // Shawn's own performance or the character-voiced version of it.
      beatId: beatId && shot.beats.some((b) => b.id === beatId) ? beatId : null,
      kind: kind === "voiced" ? "voiced" : "performance",
    };
    shot.audioClips = shot.audioClips || [];
    shot.audioClips.push(clip);
    return clip;
  });
}

r.post("/api/episode/audio/import", async ({ body }) => {
  if (!AUDIO_EXT.test(body.source || "")) throw Object.assign(new Error("audio must be .wav, .mp3, .m4a, .aac or .ogg"), { status: 400 });
  const copied = await store.copyIntoEpisode({ sourceRel: body.source, relDir: body.dir, destSub: AUDIO_SUB });
  return addAudioClip(body.dir, body.shotId, copied, { label: body.label, from: body.source, beatId: body.beatId, kind: body.kind });
});

r.post("/api/episode/audio/upload", async ({ query, body }) => {
  if (!body || !body.raw || !body.raw.length) throw Object.assign(new Error("no file data in upload"), { status: 400 });
  const filename = path.basename(query.get("filename") || `dialogue_${Date.now()}.wav`);
  if (!AUDIO_EXT.test(filename)) throw Object.assign(new Error("audio must be .wav, .mp3, .m4a, .aac or .ogg"), { status: 400 });
  const saved = await store.saveUpload({ relDir: query.get("dir"), destSub: AUDIO_SUB, filename, buffer: body.raw });
  return addAudioClip(query.get("dir"), query.get("shotId"), saved, { label: query.get("label"), from: `uploaded: ${filename}`, beatId: query.get("beatId"), kind: query.get("kind") });
});

// ---------- Dialogue lane (Post-Production > Sound) ----------

// Link an existing recording to a line (recordings made before lines could be
// linked carry no beatId).
r.post("/api/episode/audio/link", async ({ body }) =>
  edit(body.dir, (ep) => {
    const shot = ep.shots.find((s) => s.id === body.shotId);
    const clip = shot && (shot.audioClips || []).find((c) => c.id === body.audioClipId);
    if (!clip) throw Object.assign(new Error("recording not found"), { status: 404 });
    if (body.beatId && !shot.beats.some((b) => b.id === body.beatId)) throw Object.assign(new Error("line not found on this shot"), { status: 404 });
    clip.beatId = body.beatId || null;
    return clip;
  }));

// Add or change a spoken line. With no beatId it goes on the shot's first beat
// that has no line yet; if every beat already speaks, a new timing beat is
// added for it (a beat holds one line).
r.post("/api/episode/dialogue/line", async ({ body }) =>
  edit(body.dir, (ep) => {
    const shot = ep.shots.find((s) => s.id === body.shotId);
    if (!shot) throw Object.assign(new Error("shot not found"), { status: 404 });
    const line = String(body.line || "").trim();
    if (!line) throw Object.assign(new Error("the line is empty"), { status: 400 });
    let beat = body.beatId ? shot.beats.find((b) => b.id === body.beatId) : shot.beats.find((b) => !hasLine(b));
    if (body.beatId && !beat) throw Object.assign(new Error("beat not found"), { status: 404 });
    if (!beat) {
      beat = newBeat({ keyframe: false, role: "beat", desc: `line: ${line.slice(0, 40)}` });
      shot.beats.push(beat);
    }
    beat.dialogue = { charId: body.charId || null, line, delivery: String(body.delivery || "").trim() };
    return { shotId: shot.id, beatId: beat.id };
  }));

// Character voices (ElevenLabs, Shawn's own key). The list is his account's
// voices, searchable; the choice is stored on every angle of the character.
r.get("/api/voices", async ({ query }) => {
  const d = voice.voiceDrivers[query.get("driver") || "elevenlabs"];
  if (!d) throw Object.assign(new Error("unknown voice driver"), { status: 400 });
  return { status: d.status(), voices: d.status().ready ? await d.listVoices({ search: query.get("search") || "" }) : [] };
});
r.post("/api/episode/character/voice", async ({ body }) =>
  edit(body.dir, (ep) => voice.setCharacterVoice(ep, body.assetId, { voiceId: body.voiceId, voiceName: body.voiceName })));
r.post("/api/episode/voice/from-take", async ({ body }) =>
  voice.revoiceFromTake(body.dir, { shotId: body.shotId, beatId: body.beatId, inSec: body.inSec, outSec: body.outSec, driver: body.driver || "elevenlabs", removeNoise: body.removeNoise !== false }));
// SFX from picture, per shot (Post-Production > Sound). Paid on fal, so the
// same cap and confirmation as video generation.
r.post("/api/episode/sfx/prompt", async ({ body }) => edit(body.dir, (ep) => sfx.setPrompt(ep, body.shotId, body.prompt)));
r.post("/api/episode/sfx/use", async ({ body }) => edit(body.dir, (ep) => sfx.useTake(ep, body.shotId, body.takeId)));
// A sound file Shawn already has (his own foley, a test result) as a variant.
r.post("/api/episode/sfx/upload", async ({ query, body }) => {
  if (!body || !body.raw || !body.raw.length) throw Object.assign(new Error("no file data in upload"), { status: 400 });
  const filename = path.basename(query.get("filename") || `sfx_${Date.now()}.wav`);
  if (!AUDIO_EXT.test(filename)) throw Object.assign(new Error("audio must be .wav, .mp3, .m4a, .aac or .ogg"), { status: 400 });
  const dir = query.get("dir"), shotId = query.get("shotId");
  const saved = await store.saveUpload({ relDir: dir, destSub: "05_delivery/audio/sfx", filename, buffer: body.raw });
  const meta = await probe(store.absPath(saved));
  return edit(dir, (ep) => {
    const shot = ep.shots.find((x) => x.id === shotId);
    if (!shot) throw Object.assign(new Error("shot not found"), { status: 404 });
    const take = (shot.versions || []).find((v) => v.id === (shot.selectedVersions || [])[0]);
    shot.sfx = shot.sfx || { prompt: "", takes: [], useId: null };
    const t = { id: uid(), model: "import", label: query.get("label") || filename, path: saved, seconds: Math.round(meta.durationSec * 100) / 100, sourceVersionId: take ? take.id : null, driver: "import", at: new Date().toISOString() };
    shot.sfx.takes.push(t);
    if (!shot.sfx.useId) shot.sfx.useId = t.id;
    return t;
  });
});
r.post("/api/episode/sfx/quote", async ({ body }) => sfx.quoteSfx(await store.loadEpisode(body.dir), { shotId: body.shotId, model: body.model }));
r.post("/api/episode/sfx/generate", async ({ body }) =>
  sfx.generate(body.dir, { shotId: body.shotId, model: body.model, prompt: body.prompt, driver: body.driver || "fal", confirmedUSD: body.confirmedUSD },
    { drivers: jobs.drivers, ledgerState: jobs.ledgerState, enforceSpendGuards: jobs.enforceSpendGuards }));

// Room tone, per scene (Post-Production > Sound).
r.post("/api/episode/roomtone/prompt", async ({ body }) => edit(body.dir, (ep) => roomtone.setPrompt(ep, body.sceneNum, body.prompt)));
r.post("/api/episode/roomtone/use", async ({ body }) => edit(body.dir, (ep) => roomtone.useTake(ep, body.sceneNum, body.takeId)));
r.post("/api/episode/roomtone/generate", async ({ body }) =>
  roomtone.generate(body.dir, { sceneNum: body.sceneNum, prompt: body.prompt, seconds: body.seconds, driver: body.driver || "elevenlabs" }));
r.get("/api/episode/roomtone/default", async ({ query }) => {
  const ep = await store.loadEpisode(query.get("dir"));
  const sc = (ep.scenes || []).find((s) => String(s.number) === String(query.get("sceneNum")));
  if (!sc) throw Object.assign(new Error("scene not found"), { status: 404 });
  return { prompt: roomtone.defaultPrompt(sc) };
});

// Which recording is the line's final one in the edit (null = none). The
// timeline rebuild places it on the Dialogue track (A1).
r.post("/api/episode/dialogue/use", async ({ body }) =>
  edit(body.dir, (ep) => {
    const shot = ep.shots.find((s) => s.id === body.shotId);
    const beat = shot && shot.beats.find((b) => b.id === body.beatId);
    if (!beat || !beat.dialogue) throw Object.assign(new Error("line not found"), { status: 404 });
    if (body.audioClipId && !(shot.audioClips || []).some((c) => c.id === body.audioClipId)) throw Object.assign(new Error("recording not found on this shot"), { status: 404 });
    beat.dialogue.useClipId = body.audioClipId || null;
    return { beatId: beat.id, useClipId: beat.dialogue.useClipId };
  }));
r.post("/api/episode/voice/line", async ({ body }) =>
  voice.voiceLine(body.dir, { shotId: body.shotId, audioClipId: body.audioClipId, driver: body.driver || "elevenlabs" }));

// Remove a line (the beat stays — it may be a storyboard frame).
r.post("/api/episode/dialogue/clear", async ({ body }) =>
  edit(body.dir, (ep) => {
    const shot = ep.shots.find((s) => s.id === body.shotId);
    const beat = shot && shot.beats.find((b) => b.id === body.beatId);
    if (!beat) throw Object.assign(new Error("line not found"), { status: 404 });
    beat.dialogue = null;
    return { shotId: shot.id, beatId: beat.id };
  }));

// Removes the RECORD only — the file stays on disk, and any lip-sync take that
// already used it keeps its own copy of the path.
r.post("/api/episode/audio/delete", async ({ body }) =>
  edit(body.dir, (ep) => {
    const shot = ep.shots.find((s) => s.id === body.shotId);
    if (!shot) throw Object.assign(new Error("shot not found"), { status: 404 });
    shot.audioClips = (shot.audioClips || []).filter((c) => c.id !== body.audioClipId);
    return { remaining: shot.audioClips.length };
  }));

r.post("/api/episode/lipsync/quote", async ({ body }) => {
  const ep = await store.loadEpisode(body.dir);
  return jobs.quoteLipsync(ep, body);
});

r.post("/api/episode/lipsync", async ({ body }) =>
  jobs.submitLipsync(body.dir, {
    versionId: body.versionId,
    audioClipId: body.audioClipId,
    modelId: body.modelId,
    syncMode: body.syncMode,
    driver: body.driver || "fal",
    confirmedUSD: body.confirmedUSD,
  }));

// Finish an Atlas 480p draft at 1080p: a NEW take, from the draft's id.
r.post("/api/episode/finish/quote", async ({ body }) => {
  const ep = await store.loadEpisode(body.dir);
  return jobs.quoteFinish(ep, body);
});

r.post("/api/episode/finish", async ({ body }) =>
  jobs.submitFinish(body.dir, {
    versionId: body.versionId,
    modelId: body.modelId,
    driver: body.driver || "atlas",
    confirmedUSD: body.confirmedUSD,
  }));

// Upscale: a finished take in, a NEW take out. Quote first (the same numbers the
// spend guards use), then submit.
r.post("/api/episode/upscale/quote", async ({ body }) => {
  const ep = await store.loadEpisode(body.dir);
  return jobs.quoteUpscale(ep, body);
});

r.post("/api/episode/upscale", async ({ body }) =>
  jobs.submitUpscale(body.dir, {
    versionId: body.versionId,
    modelId: body.modelId,
    target: body.target || "1080p",
    useTrim: body.useTrim !== false,
    driver: body.driver, // undefined = the model row's own service
    confirmedUSD: body.confirmedUSD,
  }));

// A storyboard frame taken from a take: first frame for a "start" beat, last
// for "end", middle for "mid". For shots whose video exists but whose board
// never did (carryovers, imports) — lets them pass board approval honestly.
r.post("/api/episode/beat/frame-from-take", async ({ body }) => {
  const ep = await store.loadEpisode(body.dir);
  const shot = ep.shots.find((s) => s.id === body.shotId);
  const beat = shot && shot.beats.find((b) => b.id === body.beatId);
  const take = shot && (shot.versions || []).find((v) => v.id === body.versionId);
  if (!beat || !take || !take.path) throw Object.assign(new Error("shot, storyboard or take not found"), { status: 404 });
  const srcAbs = store.absPath(take.path);
  const meta = await probe(srcAbs);
  const at = beat.role === "end" ? Math.max(0, meta.durationSec - 0.1) : beat.role === "mid" ? meta.durationSec / 2 : 0.05;
  const name = `${path.basename(take.path, path.extname(take.path))}_${beat.role}_frame.png`;
  const destAbs = store.absPath(path.join(body.dir, "03_storyboard", name));
  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  // Never overwrite an earlier grab: pick the first free name (_2, _3, …),
  // and ffmpeg's -n refuses to clobber even if one appears in between.
  let outAbs = destAbs;
  for (let n = 2; await fs.access(outAbs).then(() => true, () => false); n++) {
    outAbs = destAbs.replace(/\.png$/, `_${n}.png`);
  }
  await new Promise((resolve, reject) => execFile("ffmpeg", ["-ss", String(at), "-i", srcAbs, "-frames:v", "1", "-n", outAbs],
    { timeout: 30000 }, (err) => (err ? reject(new Error(`ffmpeg couldn't grab a frame: ${err.message}`)) : resolve())));
  const rel = path.relative(store.ROOT, outAbs);
  return edit(body.dir, (ep2) => {
    const s2 = ep2.shots.find((s) => s.id === body.shotId);
    const b2 = s2 && s2.beats.find((b) => b.id === body.beatId);
    if (!b2) throw Object.assign(new Error("storyboard not found"), { status: 404 });
    b2.frame = { path: rel, approved: false, generatedAt: new Date().toISOString(), driver: "frame-grab", model: `from take ${take.id}` };
    return { path: rel };
  });
});

r.post("/api/media/promote", async ({ body }) => {
  const path_ = await store.promoteMedia({
    sourceAbsOrName: body.source,
    fromInbox: !!body.fromInbox,
    relDir: body.dir,
    destSub: body.destSub,
    filename: body.filename,
  });
  return { path: path_ };
});

// A file picked via the browser's native <input type=file> dialog — the
// actual fix for "the picker should let me search my whole filesystem, not
// force a typed path." The browser can't hand us a filesystem path for a
// picked file (that's blocked for security in every real browser, Electron
// aside), so it uploads the bytes as base64 and this writes them straight
// into the project.
r.post("/api/media/upload", async ({ body }) => {
  if (!body.dataBase64) throw Object.assign(new Error("no file data in upload"), { status: 400 });
  const buffer = Buffer.from(body.dataBase64, "base64");
  if (!buffer.length) throw Object.assign(new Error("uploaded file is empty"), { status: 400 });
  const path_ = await store.saveUpload({
    relDir: body.dir,
    destSub: body.destSub || "02_assets/uploads",
    filename: body.filename || `upload_${Date.now()}.png`,
    buffer,
  });
  return { path: path_ };
});

// ---------- production: models, quoting, fan-out ----------

// Which video model a Generate pane starts on. With shotId: that shot's own
// pick ("" clears it back to the episode default). Without: the episode
// default. Only a choice — nothing is generated or charged.
r.post("/api/episode/video-model", async ({ body }) =>
  edit(body.dir, (ep) => {
    const id = body.modelId || "";
    if (id && !VIDEO_MODELS.some((m) => m.id === id)) throw Object.assign(new Error(`unknown video model ${id}`), { status: 400 });
    if (body.shotId) {
      const shot = ep.shots.find((s) => s.id === body.shotId);
      if (!shot) throw Object.assign(new Error("shot not found"), { status: 404 });
      shot.videoModelId = id;
      return { shotId: shot.id, videoModelId: shot.videoModelId };
    }
    ep.defaultVideoModelId = id || null;
    return { defaultVideoModelId: ep.defaultVideoModelId };
  }));

// ---------- connections (keys) + price watch ----------
//
// Key routes only answer the app's own page: they require the x-rcs-ui
// header, which a browser won't let another website send to this server
// without a CORS preflight this server never approves.
const requireUI = (req) => {
  if (req.headers["x-rcs-ui"] !== "1") throw Object.assign(new Error("forbidden"), { status: 403 });
};
// Atlas Cloud's balance doubles as a free key check (and says whether the
// account has money). Checked when the key is saved and at most every 10 min
// while the Connections list is open.
let ATLAS_BALANCE = null;
async function checkAtlasBalance(force = false) {
  if (!process.env.ATLAS_API_KEY) { ATLAS_BALANCE = null; return null; }
  if (!force && ATLAS_BALANCE && Date.now() - ATLAS_BALANCE.at < 10 * 60 * 1000) return ATLAS_BALANCE;
  try { const b = await jobs.drivers.atlas.balance(); ATLAS_BALANCE = { usd: b.usd, at: Date.now() }; }
  catch (e) { ATLAS_BALANCE = { error: e.message, at: Date.now() }; }
  return ATLAS_BALANCE;
}
// Sume: same idea; its balance route is free and says if the key works.
let SUME_BALANCE = null;
async function checkSumeBalance(force = false) {
  if (!process.env.SUME_API_KEY) { SUME_BALANCE = null; return null; }
  if (!force && SUME_BALANCE && Date.now() - SUME_BALANCE.at < 10 * 60 * 1000) return SUME_BALANCE;
  try { const b = await jobs.drivers.sume.balance(); SUME_BALANCE = { usd: b.usd, invoiced: b.invoiced, keyOnly: !!b.keyOnly, at: Date.now() }; }
  catch (e) { SUME_BALANCE = { error: e.message, at: Date.now() }; }
  return SUME_BALANCE;
}
function providerStatus(p) {
  const key = process.env[p.env];
  let ready = false, note = "";
  if (!p.built) note = "Not available yet";
  else if (!key) note = "Not connected";
  else if (p.id === "fal" || p.id === "gemini") { const st = jobs.drivers[p.id].status(); ready = st.ready; note = st.ready ? "Connected" : st.reason || ""; }
  else if (p.id === "atlas") {
    const b = ATLAS_BALANCE;
    ready = !(b && b.error && /40[13]/.test(b.error));
    note = !b ? "Connected · balance not checked yet" : b.error ? (/40[13]/.test(b.error) ? "Atlas rejected this key — check it and connect again" : `Connected · balance check failed (${b.error})`)
      : b.usd == null ? "Connected" : b.usd <= 0 ? "Connected · balance $0 — add credit at atlascloud.ai before generating" : `Connected · balance $${b.usd.toFixed(2)}`;
  }
  else if (p.id === "sume") {
    const b = SUME_BALANCE;
    ready = !(b && b.error && /40[13]/.test(b.error));
    note = !b ? "Connected · balance not checked yet" : b.error ? (/40[13]/.test(b.error) ? "Sume rejected this key — check it and connect again" : `Connected · balance check failed (${b.error})`)
      : b.keyOnly ? "Connected · key works (this key type can't show the balance — check it at sume.com)" : b.invoiced ? "Connected · invoiced account" : b.usd == null ? "Connected" : b.usd <= 0 ? "Connected · balance $0 — add credit at sume.com before generating" : `Connected · balance $${b.usd.toFixed(2)}`;
  }
  else if (p.id === "comfy") { const st = jobs.drivers.comfy.status(); ready = st.ready; note = st.ready ? "Connected · costs show as estimates (Comfy sends no per-take charge)" : st.reason || ""; }
  else if (p.id === "elevenlabs") { const st = voice.voiceDrivers.elevenlabs.status(); ready = st.ready; note = st.ready ? "Connected" : st.reason || ""; }
  // fal's pricing check doubles as a key check: a 401 means fal refused the key.
  if (p.id === "fal" && key && (pricewatch.priceState().errors || []).some((e) => /fal pricing 401/.test(e))) { ready = false; note = "fal rejected this key — check it and connect again"; }
  else if (p.id === "anthropic" && key) { ready = true; note = "In use for Claude"; }
  else if (p.id === "openrouter" && key) { ready = true; note = llm.provider() === "openrouter" ? "In use for Claude" : "Standby — the direct Anthropic key is used first"; }
  return { id: p.id, name: p.name, category: p.category, built: p.built, covers: p.covers, keyUrl: p.keyUrl || null, env: p.env, connected: !!key, masked: providers.mask(key), ready, note };
}
// Point the running drivers at a new (or no) key.
function applyKey(p, value) {
  if (value) process.env[p.env] = value; else delete process.env[p.env];
  if (p.id === "fal" || p.id === "gemini" || p.id === "atlas" || p.id === "sume" || p.id === "comfy") jobs.drivers[p.id].key = value || "";
  if (p.id === "elevenlabs") voice.voiceDrivers.elevenlabs.key = value || "";
  if (p.id === "anthropic") llm.resetClientForTests();
}
r.get("/api/connections", async () => {
  await checkAtlasBalance();
  await checkSumeBalance();
  return { categories: providers.CATEGORIES, providers: providers.PROVIDERS.map(providerStatus) };
});
r.post("/api/connections/set", async ({ body, req }) => {
  requireUI(req);
  const p = providers.providerById(body.id);
  if (!p) throw Object.assign(new Error("unknown service"), { status: 400 });
  if (!p.built) throw Object.assign(new Error(`${p.name} isn't available yet — the app has no adapter for it`), { status: 400 });
  const key = String(body.key || "").trim();
  if (key.length < 8 || /\s/.test(key)) throw Object.assign(new Error("That doesn't look like an API key (no spaces or line breaks, at least 8 characters)."), { status: 400 });
  await providers.writeEnvKey(p.env, key);
  applyKey(p, key);
  // fal and OpenRouter: check prices now (for fal this also tests the key).
  if (p.id === "fal" || p.id === "openrouter") await pricewatch.checkPrices().catch(() => {});
  if (p.id === "atlas") await checkAtlasBalance(true);
  if (p.id === "sume") { await checkSumeBalance(true); await pricewatch.checkPrices().catch(() => {}); }
  return providerStatus(p);
});
r.post("/api/connections/remove", async ({ body, req }) => {
  requireUI(req);
  const p = providers.providerById(body.id);
  if (!p) throw Object.assign(new Error("unknown service"), { status: 400 });
  await providers.writeEnvKey(p.env, null);
  applyKey(p, null);
  return providerStatus(p);
});
r.get("/api/prices", () => pricewatch.priceState());
r.post("/api/prices/check", async () => pricewatch.checkPrices());

// ---------- Claude (server/llm.js): suggestions only, paid per call ----------

r.get("/api/llm", () => ({ ...llm.status(), models: llm.LLM_MODELS, default: llm.DEFAULT_LLM }));

// Draft a video prompt for one shot. Returns the draft; nothing is saved —
// "Use this prompt" in the browser saves it as the shot's hand-edited prompt.
r.post("/api/episode/claude/prompt", async ({ body }) =>
  llm.draftPrompt(body.dir, { shotId: body.shotId, videoModelId: body.videoModelId, llm: body.llm, intent: body.intent, seconds: body.seconds }));

// Propose shots for one scene from its script. Returns proposals only.
r.post("/api/episode/claude/shots", async ({ body }) =>
  llm.proposeShots(body.dir, { sceneNum: body.sceneNum, llm: body.llm, intent: body.intent }));

// Add the proposals Shawn ticked, at the end of their scene (letters follow).
// Dialogue lines attach to the new shot's first beat when the speaker matches
// a character in the Identity Vault.
// Drop a kept suggestion (Discard, or after Use / Add).
r.post("/api/episode/claude/clear", async ({ body }) => {
  if (!["drafts", "proposals", "assets"].includes(body.kind)) throw Object.assign(new Error("kind must be drafts, proposals or assets"), { status: 400 });
  await llm.keepResult(body.dir, body.kind, body.key, null);
  return { ok: true };
});

// Vault: draft an identity/continuity hold or an image prompt for one card.
// The draft is kept on the episode (ep.claude.assets) until saved or discarded;
// the hold itself is only written when the creator saves it.
r.post("/api/episode/claude/asset", async ({ body }) =>
  llm.draftAsset(body.dir, { assetId: body.assetId, kind: body.kind, intent: body.intent, llm: body.llm }));

// Vault: generate reference image variants for one card (charged per image).
// Nothing is attached; the browser files the keeper as an angle.
r.post("/api/episode/asset/generate", async ({ body }) =>
  jobs.generateAssetImages({ dir: body.dir, assetId: body.assetId, prompt: body.prompt, modelId: body.modelId, count: body.count, refIds: body.refIds, fmt: body.fmt }));

r.post("/api/episode/claude/shots/add", async ({ body }) =>
  edit(body.dir, (ep) => ({ added: llm.addProposedShots(ep, body.sceneNum, body.shots || []) })));

r.get("/api/models", () => ({
  // Prices shown are the live ones where the price watch has them (rates.js
  // effective*Rate); tableUSD keeps the app's own figure for comparison.
  video: VIDEO_MODELS.map((m) => ({ ...m, usdPerVideoSecond: effectiveVideoRate(m), tableUSD: m.usdPerVideoSecond, live: livePrice(m.id), confidence: liveRate(m.id) != null ? "live" : m.confidence })),
  image: IMAGE_MODELS.map((m) => ({ ...m, usdPerImage: effectiveImageRate(m), tableUSD: m.usdPerImage, live: livePrice(m.id), confidence: liveRate(m.id) != null ? "live" : m.confidence })),
  drivers: jobs.driverStatus(),
}));

// Price a batch WITHOUT committing to it. The UI shows this figure and the
// human confirms it; submit re-runs the identical computation and rejects a
// mismatch, so the number displayed is the number enforced.
r.post("/api/episode/quote", async ({ body }) => {
  const ep = await store.loadEpisode(body.dir);
  return jobs.quote(ep, { shotIds: body.shotIds || [], modelIds: body.modelIds || [], seconds: body.seconds });
});

r.get("/api/episode/ledger", async ({ query }) => {
  const ep = await store.loadEpisode(query.get("dir"));
  return jobs.ledgerState(ep);
});

r.post("/api/episode/ledger/settings", async ({ body }) =>
  edit(body.dir, (ep) => {
    ep.ledger = ep.ledger || {};
    if (body.budgetCapUSD != null) ep.ledger.budgetCapUSD = Number(body.budgetCapUSD);
    if (body.confirmAboveUSD != null) ep.ledger.confirmAboveUSD = Number(body.confirmAboveUSD);
    return jobs.ledgerState(ep);
  }));

// Spend correction from a provider invoice. Appends; never edits old entries.
r.post("/api/episode/ledger/adjust", async ({ body }) =>
  jobs.recordAdjustment(body.dir, { amountUSD: body.amountUSD, note: body.note, source: body.source }));

// ---------- reading an edited cut back from Resolve ----------
// Read-only. Shared first step of "Organize folders and footage from XML" and
// "Create Remaster project from XML" (server/cut.js has the rules).

// Every .fcpxml file and .fcpxmld bundle in the episode folder, newest first.
r.get("/api/episode/cut/files", async ({ query }) => {
  const dir = query.get("dir");
  const base = store.safeResolve(dir);
  const out = [];
  const walk = async (abs, depth) => {
    let ents;
    try { ents = await fs.readdir(abs, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(abs, e.name);
      if (/\.fcpxmld$/i.test(e.name) || (e.isFile() && /\.fcpxml$/i.test(e.name))) {
        const st = await fs.stat(full);
        out.push({ path: store.relToRoot(full), name: e.name, mtime: st.mtimeMs });
      } else if (e.isDirectory() && depth < 3 && e.name !== "takes" && e.name !== "_archive") {
        await walk(full, depth + 1);
      }
    }
  };
  await walk(base, 0);
  return out.sort((a, b) => b.mtime - a.mtime);
});

r.post("/api/episode/cut/analyze", async ({ body }) => {
  const ep = await store.loadEpisode(body.dir);
  const xml = await cut.readCutFile(store.safeResolve(body.xmlPath));
  return { xmlPath: body.xmlPath, ...cut.analyzeCut(ep, cut.parseCut(xml), store.ROOT) };
});

// Scene bins in Resolve come from a Lua script (Resolve ignores extra FCPXML
// events). Writes two scripts into Resolve's Scripts/Utility folder, plus a
// copy in the episode's 05_delivery/resolve-scripts.
r.post("/api/episode/resolve/scene-bins-script", async ({ body }) => {
  const ep = await store.loadEpisode(body.dir);
  return resolveScript.writeSceneBinScripts(ep, store.ROOT, store.safeResolve(body.dir));
});

// Remaster: preview is read-only; create makes a NEW episode folder and never
// writes to the source episode. add-back copies one left-out shot over.
r.post("/api/episode/remaster/preview", async ({ body }) => remaster.previewRemaster(body.dir, body.xmlPath));
r.post("/api/episode/remaster/create", async ({ body }) => remaster.createRemaster(body.dir, body.xmlPath));
r.post("/api/episode/remaster/add-back", async ({ body }) => remaster.addBack(body.dir, body.shotId));
// A remastered shot's proof-of-concept take, trimmed to the part in the cut,
// as a reference clip (off by default; trimmed only when switched on).
r.get("/api/episode/remaster/cut-parts", async ({ query }) => remaster.cutParts(query.get("dir"), query.get("shotId")));
r.post("/api/episode/remaster/cut-part", async ({ body }) => remaster.useCutPart(body.dir, body.shotId, Number(body.index), !!body.use, { probe }));

// Add sound to my Resolve cut: Dialogue lines and room tone placed on HIS
// edit (read from his Resolve FCPXML), written as a copy of his file.
async function soundCutPlan(dir, xmlPath) {
  const ep = await store.loadEpisode(dir);
  const xml = await cut.readCutFile(store.safeResolve(xmlPath));
  const analysis = cut.analyzeCut(ep, cut.parseCut(xml), store.ROOT);
  return { ep, xml, analysis, plan: soundcut.planSound(ep, analysis) };
}
r.post("/api/episode/soundcut/preview", async ({ body }) => {
  const { analysis, plan } = await soundCutPlan(body.dir, body.xmlPath);
  return { xmlPath: body.xmlPath, ...plan, unmatched: analysis.unmatched.length };
});
r.post("/api/episode/soundcut/write", async ({ body }) => {
  const { xml, analysis, plan } = await soundCutPlan(body.dir, body.xmlPath);
  if (!plan.dialogue.length && !plan.roomtone.length && !plan.sfx.length) throw Object.assign(new Error("Nothing to add yet: choose Use in edit for a line or a room-tone loop first."), { status: 400 });
  const out = soundcut.writeSoundCut(xml, plan, { root: store.ROOT, fps: analysis.sequence.fps || 24 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.basename(body.xmlPath).replace(/\.fcpxmld?$/i, "").replace(/ \(with sound [^)]*\)$/, "");
  const rel = `${body.dir}/05_delivery/${base} (with sound ${stamp.slice(0, 10)} ${stamp.slice(11, 13)}${stamp.slice(14, 16)}).fcpxml`;
  await fs.writeFile(store.safeResolve(rel), out.xml, "utf8");
  return { path: rel, added: out.added, removed: out.removed, lanes: out.lanes, dialogue: plan.dialogue.length, sfx: plan.sfx.length, roomtoneScenes: plan.roomtone.length, warnings: plan.warnings };
});

// Organize: preview is read-only; apply re-plans under the episode lock and
// refuses unless the plan matches the one previewed (planHash).
r.post("/api/episode/organize/preview", async ({ body }) => organize.previewOrganize(body.dir, body.xmlPath));
r.post("/api/episode/organize/apply", async ({ body }) => organize.applyOrganize(body.dir, body.xmlPath, body.planHash));
r.get("/api/episode/organize/last", async ({ query }) => {
  const last = await organize.lastOrganize(query.get("dir"));
  return last ? { folder: last.folder, at: last.map.at, relinked: last.map.relinked, renamed: last.map.renames.length } : null;
});
r.post("/api/episode/organize/reverse", async ({ body }) => organize.reverseOrganize(body.dir));

r.post("/api/episode/fanout", async ({ body }) =>
  jobs.submitFanOut(body.dir, {
    shotIds: body.shotIds || [],
    modelIds: body.modelIds || [],
    seconds: body.seconds,
    driver: body.driver || "fal",
    confirmedUSD: body.confirmedUSD,
    audio: body.audio,
  }));

// Version tray: every take across the episode, newest first per shot.
r.get("/api/episode/versions", async ({ query }) => {
  const ep = await store.loadEpisode(query.get("dir"));
  const rows = [];
  for (const s of ep.shots || []) {
    for (const v of s.versions || []) {
      const idx = (s.selectedVersions || []).indexOf(v.id);
      rows.push({ ...v, shotCode: `${s.sceneNum}${s.shotCode}`, shotLabel: s.label, sceneNum: s.sceneNum, selected: idx !== -1, trackIndex: idx });
    }
  }
  return { dir: ep.dir, versions: rows, queue: jobs.queueDepth(), ledger: jobs.ledgerState(ep) };
});

// Move one take to a different shot, or out into a brand-new shot right after
// its current one — for carryover footage where several distinct shots got
// bulk-attached to one shot record and need separating out. The take's
// selection follows it: selected on the old shot → removed from the old
// shot's selections, and the target selects it if it had no selections yet
// (an already-populated target keeps whatever it had; Shawn adds the moved
// take to the target's selection himself if he wants it stacked in too).
r.post("/api/episode/version/move", async ({ body }) =>
  edit(body.dir, (ep) => {
    const from = ep.shots.find((s) => (s.versions || []).some((v) => v.id === body.versionId));
    if (!from) throw Object.assign(new Error("take not found"), { status: 404 });
    const take = from.versions.find((v) => v.id === body.versionId);
    let to;
    if (body.newShot) {
      to = newShot({
        sceneId: from.sceneId, sceneNum: from.sceneNum, intext: from.intext, loc: from.loc, time: from.time,
        location: from.location, lighting: from.lighting, refs: [...(from.refs || [])],
        // Take labels often start with an OLD shot number ("2b - overlock
        // stirs…") that means nothing in the current list — drop it.
        label: (body.label || take.modelLabel || "").replace(/^\s*\d+[a-z]*\s*[-—–:]\s*/i, ""),
      });
      ep.shots.splice(ep.shots.indexOf(from) + 1, 0, to);
    } else {
      to = ep.shots.find((s) => s.id === body.toShotId);
      if (!to) throw Object.assign(new Error("target shot not found"), { status: 404 });
      if (to === from) return { shotId: to.id };
    }
    from.versions = from.versions.filter((v) => v !== take);
    from.selectedVersions = (from.selectedVersions || []).filter((id) => id !== take.id);
    from.vidDone = from.selectedVersions.length > 0;
    take.shotId = to.id;
    to.versions = to.versions || [];
    to.versions.push(take);
    if (!(to.selectedVersions || []).length) { to.selectedVersions = [take.id]; to.vidDone = true; }
    renumberScene(ep.shots, to.sceneNum);
    return { shotId: to.id, shotCode: `${to.sceneNum}${to.shotCode}` };
  }));

// Toggles a take in/out of the shot's selected set — multiple takes can be
// selected at once (Shawn cuts between them in Resolve). Order is meaning:
// the order takes are ADDED in is the order they land on export tracks
// (V1 = primary/first added, V2/V3... = alternates) — see timeline.js.
r.post("/api/episode/version/select", async ({ body }) =>
  edit(body.dir, (ep) => {
    const shot = ep.shots.find((s) => s.id === body.shotId);
    if (!shot) throw Object.assign(new Error("shot not found"), { status: 404 });
    shot.selectedVersions = shot.selectedVersions || [];
    if (body.action === "remove") {
      shot.selectedVersions = shot.selectedVersions.filter((id) => id !== body.versionId);
    } else if (body.action === "primary") {
      // The assembly plays the FIRST selected take; this moves one to the
      // front without dropping the other selected alternates.
      if (!(shot.versions || []).some((v) => v.id === body.versionId)) throw Object.assign(new Error("take not found on this shot"), { status: 404 });
      shot.selectedVersions = [body.versionId, ...shot.selectedVersions.filter((id) => id !== body.versionId)];
    } else if (body.versionId && !shot.selectedVersions.includes(body.versionId)) {
      shot.selectedVersions.push(body.versionId);
    }
    shot.vidDone = shot.selectedVersions.length > 0;
    return { shotId: shot.id, selectedVersions: shot.selectedVersions };
  }));

// Rename a take's label — needed for reused/recovered footage (old CapCut
// clips, say) where nothing in the app ever generated the clip and so never
// gave it a name matching the current shot list. Deliberately narrow: only
// the cosmetic label, never state/billing/path fields.
r.post("/api/episode/version/relabel", async ({ body }) =>
  edit(body.dir, (ep) => {
    for (const s of ep.shots || []) {
      const v = (s.versions || []).find((x) => x.id === body.versionId);
      if (v) { v.modelLabel = String(body.modelLabel || "").slice(0, 200); return { versionId: v.id, modelLabel: v.modelLabel }; }
    }
    throw Object.assign(new Error("version not found"), { status: 404 });
  }));

// Bulk version of relabel — strips a baked-in stale shot-code prefix
// ("2c - Overlock wakes…") from every take whose label still carries one, in
// one edit (one undo snapshot for the whole batch, not one per take). The
// client computes the proposed before/after pairs itself (stripStaleLabelPrefix
// is a pure function, same one used to decide whether to even show the
// button) and shows them to Shawn before calling this — this route just
// applies the exact pairs it's given, it doesn't re-decide anything.
r.post("/api/episode/versions/relabel-bulk", async ({ body }) =>
  edit(body.dir, (ep) => {
    const updates = Array.isArray(body.updates) ? body.updates : [];
    const byId = new Map(updates.map((u) => [u.versionId, u.modelLabel]));
    let changed = 0;
    for (const s of ep.shots || []) {
      for (const v of s.versions || []) {
        if (byId.has(v.id)) { v.modelLabel = String(byId.get(v.id) || "").slice(0, 200); changed++; }
      }
    }
    return { changed };
  }));

r.post("/api/episode/version/cancel", async ({ body }) => jobs.cancelVersion(body.dir, body.versionId));

r.post("/api/episode/version/delete", async ({ body }) =>
  edit(body.dir, (ep) => {
    for (const s of ep.shots || []) {
      const before = (s.versions || []).length;
      s.versions = (s.versions || []).filter((v) => v.id !== body.versionId);
      if (s.versions.length !== before) s.selectedVersions = (s.selectedVersions || []).filter((id) => id !== body.versionId);
    }
    return { ok: true };
  }));

// ---------- post-production: timeline & export ----------

r.post("/api/episode/timeline/rebuild", async ({ body }) =>
  edit(body.dir, async (ep) => timeline.rebuildFromSelection(ep)));

r.get("/api/episode/timeline", async ({ query }) => {
  const ep = await store.loadEpisode(query.get("dir"));
  return { dir: ep.dir, timeline: ep.timeline };
});

// Mark the usable part of a take: { inSec, outSec } in the take's own time
// (null = its start / end), plus optional `cuts: [{ startSec, endSec }]` removed
// from inside it (omitted = keep the cuts already stored; [] = clear them).
// Both in/out null and no cuts clears the marks. Saved on the shot and applied
// straight away to the timeline (if one is built), so the next FCPXML carries
// it without a manual rebuild. `spans` in the reply are the kept pieces.
r.post("/api/episode/take/trim", async ({ body }) =>
  edit(body.dir, async (ep) => {
    const shot = ep.shots.find((s) => s.id === body.shotId);
    const v = shot && (shot.versions || []).find((x) => x.id === body.versionId);
    if (!v || v.state !== "done" || !v.path) throw Object.assign(new Error("finished take not found"), { status: 404 });
    const { durationSec } = await probe(store.safeResolve(v.path));
    shot.takeTrims = shot.takeTrims || {};
    const { trim, spans } = parseTrimRequest(body, durationSec, shot.takeTrims[v.id] || null);
    if (!trim) delete shot.takeTrims[v.id];
    else shot.takeTrims[v.id] = trim;
    const built = ((ep.timeline.tracks || []).find((t) => t.id === "V1")?.clips || []).length > 0;
    if (built) await timeline.rebuildFromSelection(ep);
    return { versionId: v.id, trim: shot.takeTrims[v.id] || null, spans, durationSec, rebuilt: built };
  }));

r.post("/api/episode/timeline/clip/trim", async ({ body }) =>
  edit(body.dir, (ep) => {
    const track = ep.timeline.tracks.find((t) => t.id === (body.trackId || "V1"));
    const clip = track?.clips.find((c) => c.id === body.clipId);
    if (!clip) throw Object.assign(new Error("clip not found"), { status: 404 });
    const maxTrim = clip.sourceDurationSec || 0;
    const head = Math.max(0, Math.min(Number(body.headTrimSec ?? clip.headTrimSec), maxTrim));
    const tail = Math.max(0, Math.min(Number(body.tailTrimSec ?? clip.tailTrimSec), maxTrim - head));
    clip.headTrimSec = head;
    clip.tailTrimSec = tail;
    timeline.resequence(track);
    return clip;
  }));

// Shared precondition + payload for all three export routes. audioCues comes
// straight off the timeline, set by the last rebuild — see timeline.js.
function exportContext(ep) {
  const clipsByTrack = timeline.clipsByTrackId(ep);
  if (!(clipsByTrack.V1 || []).length) {
    throw Object.assign(new Error("no clips on the timeline — rebuild it from selected takes first"), { status: 400 });
  }
  return { clipsByTrack, audioCues: ep.timeline.audioCues || [] };
}

r.post("/api/episode/export/fcpxml", async ({ body }) =>
  edit(body.dir, async (ep) => {
    const { clipsByTrack } = exportContext(ep);
    // The timeline is the PROJECT's size (9:16 -> 1080x1920, 16:9 -> 1920x1080), not
    // whatever the first clip happens to be: clips arrive in mixed sizes.
    const sequenceSize = ep.fmt === "16:9" ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
    const xml = buildFCPXML(ep.timeline, clipsByTrack, { projectName: ep.name, rootAbs: store.ROOT, sequenceSize });
    const outRel = `${body.dir}/05_delivery/${body.filename || ep.name.replace(/[^A-Za-z0-9]+/g, "_")}.fcpxml`;
    const written = await store.writeText(outRel, xml);
    ep.exports.push({ kind: "fcpxml", path: written, at: new Date().toISOString() });
    // Resolve ignores bins inside an FCPXML, so every export also refreshes
    // this episode's scene-bins script (Workspace > Scripts). Never fails the
    // export itself.
    const binsScript = await resolveScript.writeSceneBinScripts(ep, store.ROOT, store.safeResolve(body.dir)).catch((e) => ({ error: e.message }));
    return { path: written, bytes: xml.length, binsScript };
  }));

r.post("/api/episode/export/otio", async ({ body }) =>
  edit(body.dir, async (ep) => {
    const { clipsByTrack } = exportContext(ep);
    const doc = buildOTIO(clipsByTrack, { projectName: ep.name, fps: ep.timeline.fps, rootAbs: store.ROOT });
    const json = JSON.stringify(doc, null, 2);
    const outRel = `${body.dir}/05_delivery/${body.filename || ep.name.replace(/[^A-Za-z0-9]+/g, "_")}.otio`;
    const written = await store.writeText(outRel, json);
    ep.exports.push({ kind: "otio", path: written, at: new Date().toISOString() });
    return { path: written, bytes: json.length };
  }));

r.post("/api/episode/export/capcut", async ({ body }) =>
  edit(body.dir, async (ep) => {
    const { clipsByTrack, audioCues } = exportContext(ep);
    const plan = orderedCopyPlan(clipsByTrack);
    const destSub = "05_delivery/capcut_order";
    const copied = [];
    for (const p of plan) {
      const rel = await store.copyFile(p.from, `${body.dir}/${destSub}/${p.toName}`);
      copied.push(rel);
    }
    const sheet = buildEditSheet(clipsByTrack, { projectName: ep.name, audioCues });
    const sheetPath = await store.writeText(`${body.dir}/05_delivery/edit_sheet.md`, sheet);
    ep.exports.push({ kind: "capcut", path: sheetPath, at: new Date().toISOString() });
    return { copied, sheetPath, destSub: `${body.dir}/${destSub}` };
  }));

// ---------- media passthrough ----------

// Serve any file inside the project root so the browser can show real images and
// video. safeResolve rejects anything that climbs out.
r.get("/media", async ({ query, req, res }) => {
  const rel = query.get("p");
  if (!rel) return sendJSON(res, 400, { error: "missing ?p=" });
  const abs = store.safeResolve(rel);
  // ?w=480 asks for a cached thumbnail. Full size is still one click away.
  const w = Number(query.get("w") || 0);
  if (w > 0) {
    const t = await thumbnail(abs, Math.min(w, 2048));
    if (t) return sendFile(res, t, req);
  }
  return sendFile(res, abs, req);
});

const PORT = Number(process.env.PORT || 8099);
serve({
  port: PORT,
  router: r,
  staticDir: WEB,
  staticMounts: [{ prefix: "/shared", dir: path.join(REPO, "shared") }],
  onListen: async (p) => {
    // Same-model price checks: at startup, then every 6 hours (server/pricewatch.js).
    pricewatch.startPriceWatch();
    console.log(`Red Clover Studio  ·  http://localhost:${p}`);
    console.log(`  project root : ${store.ROOT || "not chosen yet — the Library will ask"}`);
    const ds = jobs.driverStatus();
    console.log(`  drivers      : ${Object.values(ds).map((d) => `${d.name}=${d.ready ? "ready" : "off"}`).join(" ")}`);
    // Re-attach anything that was mid-generation when the server stopped, so a
    // restart never orphans a job that has already been paid for.
    const resumed = await jobs.resumeInFlight().catch(() => 0);
    if (resumed) console.log(`  resumed      : ${resumed} in-flight job(s)`);
  },
});
