// Red Clover Studio — browser desk.
// The server owns prompt wording and persistence. This file renders what it is
// handed and posts edits back; it never re-implements a prompt.

import { episodeAxisWarnings } from "/shared/blocking.js";
import { beatFrameName, stripStaleLabelPrefix } from "/shared/grammar.js";
import { resolveStartEndBeats, resolveReferencePrompt, resolveFramesRefPrompt, usableHold, refVideoSet } from "/shared/prompts.js";
import { blockingSentence } from "/shared/blocking.js";
import { dialogueLines, speakers, lineStatus } from "/shared/dialogue.js";
import { videoModelFor, nearestSellable } from "/shared/schema.js";
import { defaultRoomTonePrompt, defaultSfxPrompt } from "/shared/sound.js";
import { trimSpans, spansDuration, isWholeTake } from "/shared/trim.js";

const $ = (s) => document.querySelector(s);
const el = (t, c, txt) => { const e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; };
const api = async (p, opts = {}) => {
  // x-rcs-ui marks requests from this page; the key routes refuse anything without it.
  const res = await fetch(p, { ...opts, headers: { ...(opts.headers || {}), "x-rcs-ui": "1" } });
  const data = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
  // A route may answer a plain null ("nothing there", e.g. organize/last).
  if (!res.ok || (data && data.error)) throw new Error((data && data.error) || `${res.status}`);
  return data;
};
// Any write to an episode can add an undo step, so the Undo counter refreshes
// after each one (debounced; scheduleUndoRefresh is hoisted below).
const afterWrite = (p) => (r) => { if (p.startsWith("/api/episode")) scheduleUndoRefresh(); return r; };
const post = (p, body) => api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(afterWrite(p));
const put = (p, body) => api(p, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(afterWrite(p));
const mediaURL = (rel, w) => `/media?p=${encodeURIComponent(rel)}${w ? `&w=${w}` : ""}`;

let GRAMMAR = {};
const app = () => $("#app");
// A failed action's error used to prepend into #app — the very top of a
// 15,000px episode page. Scrolled down anywhere else (boarding a scene,
// editing a shot), that read as the action doing nothing at all: the message
// was real, just off-screen. Fixed-position toast, same fix flashNote already
// applies to success messages, just error-colored and slower to auto-dismiss
// (error text tends to be a full sentence explaining a refusal, not a
// one-liner).
const fail = (e) => {
  const n = Object.assign(el("div", "err err-toast"), { textContent: e.message || String(e) });
  document.body.append(n);
  setTimeout(() => n.remove(), 8000);
};

// ---------------- library ----------------

async function renderLibrary() {
  location.hash = "";
  IN_EPISODE = false; if (undoBtn) undoBtn.style.display = "none";
  document.body.classList.remove("episode-view");
  document.body.classList.add("rc", "rc-lib");
  clearTimeout(SHELL_POLL);
  const tree = await api("/api/tree");
  const root = app();
  root.innerHTML = "";

  // Same top bar as an episode, without the stages.
  const top = el("header", "rc-top lib");
  const logo = el("div", "rc-logo");
  logo.innerHTML = `<span class="title">${CLOVER_SVG}<span>Red Clover</span></span><span class="sub"><span></span></span>`;
  logo.querySelector(".sub span").textContent = "LIBRARY";
  const mid = el("div", "rc-libroot", tree.root || "");
  mid.title = "Your projects folder";
  if (tree.root) {
    const ch = el("button", "rc-btn", "CHANGE");
    ch.title = "Point the app at another projects folder";
    ch.onclick = () => { root.querySelector(".rc-libin").prepend(rootChooser(tree.root)); ch.remove(); };
    mid.append(ch);
  }
  const right = el("div", "rc-meter");
  const np = el("button", "rc-btn primary", "+ NEW PROJECT");
  right.append(np);
  top.append(logo, libNav("library"), mid, right);
  root.append(top);

  const page = el("div", "rc-page"); page.dataset.keepScroll = "library";
  const inner = el("div", "rc-libin");
  const npForm = newProjectForm(); npForm.style.display = "none";
  np.onclick = () => { npForm.style.display = npForm.style.display === "none" ? "" : "none"; };
  inner.append(npForm);
  page.append(inner);
  root.append(page);

  if (tree.needsRoot) {
    inner.append(rootChooser(null));
    np.style.display = "none";
    return;
  }
  if (tree.rootError) {
    const msg = tree.rootError.code === "EPERM"
      ? "macOS is blocking the server from reading the project folder (EPERM). Quit the server and relaunch from the Dock app, which starts it via Terminal — and check System Settings → Privacy & Security → Full Disk Access → Terminal is on."
      : `Can't read the project folder: ${tree.rootError.message}`;
    inner.append(Object.assign(el("div", "err"), { textContent: msg }));
    return;
  }
  if (!tree.series.length && !tree.standalone.length) {
    const e = el("div", "rc-libempty");
    e.append(el("div", "h", "No projects yet"), el("div", "rc-note", "Start one with + NEW PROJECT: name the series, upload the script, and the setup walks you through the rest. Or look around a project that's already under way first."));
    e.append(sampleButton(true));
    inner.append(e);
    npForm.style.display = "";
    return;
  }

  const section = (title, meta, episodes, series) => {
    const sec = el("section", "rc-libsec");
    const h = el("div", "rc-libh");
    h.append(el("h2", null, title), el("span", "meta", meta));
    if (series) {
      const ne = el("button", "rc-btn", "+ NEW EPISODE");
      ne.title = "Starts with this series' vault, style, ban list, format and model";
      const f = el("span", "rc-newep"); f.style.display = "none";
      const nm = Object.assign(document.createElement("input"), { placeholder: "Episode, e.g. S1E2" });
      const go = el("button", "rc-btn primary", "CREATE");
      const create = async () => {
        if (!nm.value.trim()) { nm.focus(); return; }
        try { const r = await post("/api/project/create", { series: series.dir, episode: nm.value }); await openEpisode(r.dir, r.seriesDir); }
        catch (e) { fail(e); }
      };
      go.onclick = create; nm.onkeydown = (e) => { if (e.key === "Enter") create(); };
      f.append(nm, go);
      ne.onclick = () => { f.style.display = f.style.display === "none" ? "" : "none"; if (f.style.display === "") nm.focus(); };
      const rc = el("button", "rc-btn", "+ REMASTER FROM A RESOLVE CUT");
      rc.title = "A new episode from your edit of one of these episodes: shots in cut order, no takes, target lengths from the cut. Costs nothing.";
      const rf = fromCutForm(series, episodes.filter((e) => e.initialised)); rf.style.display = "none";
      rc.onclick = () => { rf.style.display = rf.style.display === "none" ? "" : "none"; };
      h.append(f, ne, rc);
      sec.append(h, rf);
    }
    if (!series) sec.append(h);
    const ready = episodes.filter((e) => e.initialised);
    const other = episodes.filter((e) => !e.initialised);
    const grid = el("div", "rc-epgrid");
    ready.forEach((e) => grid.append(episodeCard(e, series)));
    if (!ready.length) grid.append(el("div", "rc-muted", "No episodes set up yet."));
    sec.append(grid);
    if (other.length) {
      const d = el("details", "rc-libother");
      d.append(Object.assign(el("summary"), { textContent: `${other.length} OTHER FOLDER${other.length === 1 ? "" : "S"} (NOT EPISODES YET)` }));
      other.forEach((e) => {
        const r = el("div", "rc-missrow");
        r.append(el("span", "t", "FOLDER"), el("span", "n", e.name));
        const mig = el("button", "rc-btn", "IMPORT V1 EXPORT…");
        mig.onclick = () => renderMigrate(e.dir, series);
        r.append(mig);
        d.append(r);
      });
      sec.append(d);
    }
    inner.append(sec);
  };
  for (const s of tree.series) {
    const n = s.episodes.filter((e) => e.initialised).length;
    section(s.name, `${n} EPISODE${n === 1 ? "" : "S"}${s.bible ? " · BIBLE" : ""}`, s.episodes, s);
  }
  inner.append(sampleButton(false));
  if (tree.standalone.length) section("Standalone", `${tree.standalone.length} PRODUCTION${tree.standalone.length === 1 ? "" : "S"}`, tree.standalone, null);
}

// Library: + REMASTER FROM A RESOLVE CUT. Pick the episode you cut and the
// FCPXML you exported into its folder; the preview and Create are the same as
// Post-production → From Resolve used to offer.
function fromCutForm(series, episodes) {
  const box = el("div", "rc-fromcut");
  box.append(el("span", "h", "REMASTER OF"));
  const epSel = document.createElement("select");
  epSel.append(Object.assign(document.createElement("option"), { value: "", textContent: "Episode you cut…" }));
  episodes.filter((e) => !/ - Remaster( \d+)?$/.test(e.dir)).forEach((e) => epSel.append(Object.assign(document.createElement("option"), { value: e.dir, textContent: e.name })));
  const xmlSel = document.createElement("select"); xmlSel.disabled = true;
  xmlSel.append(Object.assign(document.createElement("option"), { value: "", textContent: "FCPXML…" }));
  const pv = el("button", "rc-btn primary", "PREVIEW"); pv.disabled = true;
  const out = el("div", "out rc-legacy");
  epSel.onchange = async () => {
    xmlSel.innerHTML = ""; xmlSel.disabled = true; pv.disabled = true; out.innerHTML = "";
    if (!epSel.value) return;
    try {
      const files = await api(`/api/episode/cut/files?dir=${encodeURIComponent(epSel.value)}`);
      if (!files.length) { xmlSel.append(Object.assign(document.createElement("option"), { value: "", textContent: "No .fcpxml in that episode's folder" })); out.append(el("div", "rc-muted", "Export the timeline from Resolve as FCPXML into that episode's folder (05_delivery is fine), then pick the episode again.")); return; }
      files.forEach((f) => xmlSel.append(Object.assign(document.createElement("option"), { value: f.path, textContent: `${f.name} · ${new Date(f.mtime).toLocaleDateString()}` })));
      xmlSel.disabled = false; pv.disabled = false;
    } catch (e) { fail(e); }
  };
  pv.onclick = async () => {
    out.innerHTML = '<div class="mini">Reading the cut…</div>';
    try { renderRemasterPreview(out, await post("/api/episode/remaster/preview", { dir: epSel.value, xmlPath: xmlSel.value }), { dir: epSel.value, seriesDir: series.dir }); }
    catch (e) { out.innerHTML = ""; fail(e); }
  };
  box.append(epSel, xmlSel, pv, out);
  return box;
}

// ---------- module slots (placeholders, 2026-10-12) ----------
// Agreed with the modules-marketplace research: reserve the places in the UI
// now, build the system later. Modules are data only (shot recipes, previz /
// motion clips, styles, sequences); no LoRAs; applying one is a suggestion,
// never a block, and the prompt shown is the prompt sent.
const MODULES_SOON = "Modules are coming in a later version.";
function libNav(active) {
  const n = el("nav", "rc-libnav");
  [["library", "LIBRARY", renderLibrary], ["modules", "MODULES", () => renderModulesPage("modules")], ["browse", "BROWSE", () => renderModulesPage("browse")]]
    .forEach(([id, label, go]) => { const b = el("button", id === active ? "on" : null, label); b.onclick = go; n.append(b); });
  return n;
}
function renderModulesPage(kind) {
  location.hash = "";
  const root = app();
  root.innerHTML = "";
  const top = el("header", "rc-top lib");
  const logo = el("div", "rc-logo");
  logo.innerHTML = `<span class="title">${CLOVER_SVG}<span>Red Clover</span></span><span class="sub"><span></span></span>`;
  logo.querySelector(".sub span").textContent = kind === "browse" ? "BROWSE" : "MODULES";
  top.append(logo, libNav(kind), el("div", "rc-libroot", ""), el("div", "rc-meter"));
  root.append(top);
  const page = el("div", "rc-page"); const inner = el("div", "rc-libin"); page.append(inner); root.append(page);
  const box = el("div", "rc-libempty");
  if (kind === "browse") {
    box.append(el("div", "h", "Browse modules"), el("div", "rc-note", "Shot recipes, previz and motion clips, looks and multi-shot sequences shared by other creators, free or paid. You'll preview each one here and add it to your library. " + MODULES_SOON));
  } else {
    box.append(el("div", "h", "Your modules"), el("div", "rc-note", "Reusable pieces of a production, saved from your own work or added from Browse. " + MODULES_SOON));
    const types = [["SHOTS", "camera-move recipes: a prompt per model, keyframe spec, optional reference clip"], ["PREVIZ", "grey-box or Blender clips that steer camera, staging and timing"], ["MOTION", "performance and action references (a fight beat, a stunt)"], ["STYLES", "a look: style text, words to avoid, reference stills"], ["SEQUENCES", "multi-shot patterns, e.g. a 6-shot exchange"]];
    const list = el("div", "rc-modtypes");
    types.forEach(([t, d]) => { const r = el("div", "rc-missrow"); r.append(el("span", "t", t), el("span", "n", d)); list.append(r); });
    box.append(list, el("div", "rc-muted", "Modules hold data only (text, images, clips), never code. On a shot they're a suggestion you can remove; the prompt shown is always the prompt sent."));
  }
  inner.append(box);
}

// The sample project (Fashion Heist, two scenes): copied into the projects
// folder and opened. Hidden once it's installed or if this copy has none.
function sampleButton(prominent) {
  const wrap = el("div", prominent ? "rc-actions" : "rc-samplelink");
  api("/api/sample").then((S) => {
    if (!S.available || S.installed) return;
    const b = el("button", prominent ? "rc-btn primary" : "rc-btn", prominent ? "OPEN THE SAMPLE PROJECT" : "+ ADD THE SAMPLE PROJECT");
    b.title = "Two scenes of the microdrama Fashion Heist, part storyboarded, part shot. Copied into your projects folder; nothing is spent.";
    b.onclick = async () => {
      b.disabled = true;
      try { const r = await post("/api/sample/install", {}); await openEpisode(r.dir, r.seriesDir); }
      catch (e) { b.disabled = false; fail(e); }
    };
    wrap.append(b);
  }).catch(() => {});
  return wrap;
}

// First run (and Library → CHANGE): where the projects live. A browser page
// can't open a native folder picker that returns a path, so the folder is
// typed (with a suggestion) and the server checks it.
function rootChooser(current) {
  const box = el("div", "rc-libempty rc-rootpick");
  box.append(el("div", "h", current ? "Change projects folder" : "Welcome to Red Clover Studio"));
  box.append(el("div", "rc-note", current
    ? "Every series and episode lives as folders inside one projects folder. Switching only changes where the app looks; nothing is moved or deleted."
    : "First, choose the folder your projects will live in. Each series becomes a folder inside it, with your script, images, storyboards and takes as ordinary files you can open, back up or sync (Dropbox, Google Drive, iCloud)."));
  const row = el("div", "rc-actions");
  const input = Object.assign(document.createElement("input"), { placeholder: "/Users/you/Red Clover Projects", value: current || "" });
  input.style.minWidth = "420px";
  const create = Object.assign(document.createElement("input"), { type: "checkbox", checked: !current });
  const cl = el("label", "rc-check"); cl.append(create, document.createTextNode(" create it if it doesn't exist"));
  const go = el("button", "rc-btn primary", current ? "USE THIS FOLDER" : "START");
  const st = el("div", "rc-muted");
  api("/api/settings").then((S) => {
    if (!input.value) input.value = S.suggestedRoot;
    if (S.rootFromEnv) { go.disabled = true; st.textContent = "This server was started with RCS_PROJECT_ROOT, which fixes the folder."; }
    else st.textContent = `Saved in ${S.settingsFile}.`;
  }).catch(() => {});
  go.onclick = async () => {
    go.disabled = true;
    try { await post("/api/settings/root", { path: input.value, create: create.checked }); await renderLibrary(); }
    catch (e) { go.disabled = false; fail(e); }
  };
  input.onkeydown = (e) => { if (e.key === "Enter") go.click(); };
  row.append(input, cl, go);
  box.append(row, st);
  if (current) { const x = el("button", "rc-btn", "CANCEL"); x.onclick = () => renderLibrary(); row.append(x); }
  return box;
}

// One card per episode: cover (first approved board), name, progress. The
// detail comes from the episode itself, fetched per card after the grid draws.
function episodeCard(e, series) {
  const c = el("button", "rc-epcard");
  const cover = el("div", "cover"); c.append(cover);
  const body = el("div", "b");
  body.append(el("div", "nm", e.name));
  const stats = el("div", "st", `${e.shots ?? 0} SHOTS`);
  body.append(stats);
  const bar = el("div", "bar"); const fill = el("i"); bar.append(fill); body.append(bar);
  c.append(body);
  c.onclick = () => openEpisode(e.dir, series ? series.dir : null);
  api(`/api/episode?dir=${encodeURIComponent(e.dir)}`).then((ep) => {
    const shots = ep.shots || [];
    const kf = shots.flatMap((s) => (s.beats || []).filter((b) => b.keyframe));
    const appr = kf.filter((b) => b.frame && b.frame.approved).length;
    const takes = shots.filter((s) => (s.selectedVersions || []).length).length;
    const first = kf.find((b) => b.frame && b.frame.approved && b.frame.path) || kf.find((b) => b.frame && b.frame.path);
    if (first) cover.style.backgroundImage = `url("${mediaURL(first.frame.path, 480)}")`;
    else cover.append(el("span", null, (ep.scenes || []).length ? "NO BOARDS YET" : "SET UP"));
    body.querySelector(".nm").textContent = ep.name || e.name;
    stats.textContent = shots.length ? `${shots.length} SHOTS · BOARDS ${appr}/${kf.length} · TAKES ${takes}/${shots.length}` : `${(ep.scenes || []).length} SCENES · NO SHOTS YET`;
    fill.style.width = `${pctOf(appr + takes, kf.length + shots.length)}%`;
    if (ep.updatedAt) { const d = new Date(ep.updatedAt); body.append(el("div", "up", `EDITED ${d.toLocaleDateString(undefined, { day: "numeric", month: "short" }).toUpperCase()}`)); }
  }).catch(() => {});
  return c;
}

async function renderMigrate(dir, series) {
  const root = app();
  root.innerHTML = "";
  const back = el("button", null, "← Library"); back.onclick = renderLibrary;
  root.append(back);

  const c = el("div", "card");
  c.append(el("h2", null, `Import into ${dir}`));
  c.append(Object.assign(el("div", "mini"), { textContent: "The v1 desk stored everything in browser localStorage. These are the JSON exports it wrote into this folder. The newest is normally the one you want." }));
  root.append(c);

  const { exports: list } = await api(`/api/migrate/scan?dir=${encodeURIComponent(dir)}`);
  if (!list.length) {
    c.append(Object.assign(el("div", "empty"), { textContent: "No v1 exports found in this folder." }));
    return;
  }
  for (const ex of list) {
    for (const p of ex.productions) {
      const row = el("div", "eprow");
      row.append(Object.assign(el("div"), { textContent: p.name, style: "flex:1" }));
      row.append(Object.assign(el("span", "mini"), { textContent: ex.file }));
      row.append(Object.assign(el("span", "pill"), { textContent: ex.mtime.slice(0, 10) }));
      row.append(Object.assign(el("span", "pill"), { textContent: `${p.shots} shots · ${p.assets} assets` }));
      const b = el("button", "primary", "Import");
      b.onclick = async () => {
        b.disabled = true; b.textContent = "Importing…";
        try {
          await post("/api/migrate/import", { dir, file: ex.file, productionName: p.name, name: p.name });
          openEpisode(dir, series ? series.dir : null);
        } catch (err) { fail(err); b.disabled = false; b.textContent = "Import"; }
      };
      row.append(b);
      c.append(row);
    }
  }
}

// ---------------- episode ----------------

let EP = null, PROMPTS = null, SERIES_DIR = null;

async function openEpisode(dir, seriesDir) {
  if (seriesDir !== undefined) SERIES_DIR = seriesDir;
  location.hash = `#ep=${encodeURIComponent(dir)}${SERIES_DIR ? `&series=${encodeURIComponent(SERIES_DIR)}` : ""}`;
  app().innerHTML = '<div class="empty">Loading episode…</div>';
  try {
    EP = await api(`/api/episode?dir=${encodeURIComponent(dir)}`);
    PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(dir)}`);
    // boardPanel's storyboard-overflow warning needs MODELS (image slot
    // counts) on the FIRST render, not lazily the way videoGeneratePane loads
    // it per-shot — otherwise it renders against an empty model list and
    // under-counts how many images a model actually takes.
    if (!MODELS) MODELS = await api("/api/models");
    renderEpisode();
    notifyPriceDrops();
  } catch (e) { app().innerHTML = ""; fail(e); }
}


// The whole episode is one page, rebuilt from scratch on every edit — a
// storyboard row loading its image, a gate count changing, another shot
// collapsing, any of it can change the page's height ABOVE where you were
// working. Restoring the raw scroll offset (scrollY) then lands on whatever
// content now sits at that pixel, which is the "jumps to a different point"
// bug. Anchoring on the shot's OWN element instead — same shot, same spot in
// the viewport, regardless of what shifted elsewhere — fixes it structurally.
// Every element that can hold your place for a shot: its entry in the Shots
// list AND each of its storyboard rows (tagged data-board-shot, a DIFFERENT
// attribute from data-shot-id on purpose — that one must only ever match the
// Shots list). An edit made in the Storyboard panel used to anchor on the
// Shots-list entry thousands of pixels below, so nothing held the row you
// were actually working on. Now the candidate nearest the viewport wins.
function anchorCandidates(shotId) {
  const id = CSS.escape(String(shotId));
  return [...document.querySelectorAll(`details[data-shot-id="${id}"], details.board[data-board-shot="${id}"]`)];
}
function anchorSelector(el) {
  return el.dataset.beatId
    ? `details.board[data-beat-id="${CSS.escape(el.dataset.beatId)}"]`
    : `details[data-shot-id="${CSS.escape(el.dataset.shotId)}"]`;
}
function withShotAnchor(shotId, fn) {
  // Remember EVERY candidate's position, nearest-to-viewport first. After the
  // re-render we correct against the first one that still exists — so
  // deleting the very row you were anchored on falls back to a sibling
  // instead of losing the anchor entirely.
  const cands = shotId
    ? anchorCandidates(shotId)
        .map((e) => ({ sel: anchorSelector(e), top: e.getBoundingClientRect().top }))
        .sort((a, b) => Math.abs(a.top) - Math.abs(b.top))
    : [];
  fn();
  if (!cands.length) return;
  // One correction right after fn() isn't enough: the browser can clamp
  // scrollTo/scrollBy against a scrollHeight that hasn't caught up yet —
  // fn() just inserted a page's worth of fresh <img> elements (storyboard
  // thumbnails, keyframe library grids), and until those decode and the
  // browser reflows for real, the page can measure shorter than it will be a
  // moment later. A single scrollBy against that transient, too-short height
  // gets silently clamped and never revisited once the real height arrives —
  // that's the "jumps to the top" bug. Re-applying the same correction across
  // a few animation frames converges on the right position once layout
  // settles, without depending on knowing exactly when every image decodes.
  const correct = () => {
    for (const c of cands) {
      const after = document.querySelector(c.sel);
      if (after) { window.scrollBy(0, after.getBoundingClientRect().top - c.top); return; }
    }
  };
  correct();
  requestAnimationFrame(() => { correct(); requestAnimationFrame(correct); });
  setTimeout(correct, 150);
  setTimeout(correct, 400);
}

// For a reload that has no single shot to anchor on ahead of time — a
// background poll picking up a finished/failed take, say — this discovers
// one from the CURRENT viewport instead of falling back to a blind scrollY
// restore. That blind fallback is exactly the bug withShotAnchor exists to
// fix (Sept 2026), just triggered a few seconds later by a poll instead of
// immediately by the click: Production's poller used to save/restore raw
// scrollY around its own reload, so a take finishing while you'd moved on to
// editing a different shot could yank you back to wherever the Storyboard
// panel (which sits above the Shots list and can itself change height as
// gates/approvals update) happened to be at that exact scrollY. Picks the
// last shot whose top edge is at or above a small header-clearance offset,
// or the first one below the fold if none qualify — either way, "whichever
// shot you're actually looking at."
function currentAnchorShotId() {
  const HEADER_CLEARANCE = 80;
  // Storyboard rows come before the Shots list in the document, so this
  // combined scan is still in top-to-bottom order.
  const all = document.querySelectorAll("details[data-shot-id], details.board[data-board-shot]");
  let best = null;
  for (const d of all) {
    if (d.getBoundingClientRect().top <= HEADER_CLEARANCE) best = d;
    else { if (!best) best = d; break; }
  }
  return best ? (best.dataset.shotId || best.dataset.boardShot) : null;
}

// Reload EP from disk (any server-side write — override, registry add, gate
// change — must go through this before re-rendering, or the audit/gate panels
// render against a stale in-memory EP and the UI appears to do nothing).
// Pass the shot being edited as anchorShotId to keep it in view (see
// withShotAnchor); omit it for edits with no single shot to anchor on.
async function reloadEpisode(anchorShotId) {
  EP = await api(`/api/episode?dir=${encodeURIComponent(EP.dir)}`);
  if (anchorShotId) withShotAnchor(anchorShotId, renderEpisode);
  else renderEpisode();
}

// ---------------- undo ----------------
// The server snapshots the episode before every edit made here; Undo steps
// back one snapshot. Cmd/Ctrl+Z triggers it too — except while typing in a
// field, where the browser's own text undo should win.
let undoBtn = null;
let IN_EPISODE = false;
let undoRefreshTimer = null;
const scheduleUndoRefresh = () => { clearTimeout(undoRefreshTimer); undoRefreshTimer = setTimeout(refreshUndo, 300); };
async function refreshUndo() {
  if (!undoBtn) {
    undoBtn = el("button", "undo-float", "↶ Undo");
    undoBtn.onclick = doUndo;
    document.body.append(undoBtn);
  }
  if (!EP || !IN_EPISODE) { undoBtn.style.display = "none"; return; }
  try {
    const { depth } = await api(`/api/episode/history?dir=${encodeURIComponent(EP.dir)}`);
    undoBtn.style.display = "";
    undoBtn.disabled = !depth;
    undoBtn.textContent = depth ? `↶ Undo (${depth})` : "↶ Undo";
    undoBtn.title = depth ? "Undo your last change (Cmd+Z)" : "Nothing to undo";
  } catch { undoBtn.style.display = "none"; }
}
async function doUndo() {
  if (!EP || !undoBtn || undoBtn.disabled) return;
  undoBtn.disabled = true;
  try {
    await post("/api/episode/undo", { dir: EP.dir });
    PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`);
    await reloadEpisode(currentAnchorShotId());
    flashNote("Undone.");
  } catch (e) { fail(e); refreshUndo(); }
}
document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z" || e.shiftKey) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  e.preventDefault();
  doUndo();
});

const saveEp = () => put(`/api/episode?dir=${encodeURIComponent(EP.dir)}`, EP).catch(fail);





function field(label, value, onChange, options) {
  const l = el("label", "f");
  l.append(el("span", null, label));
  if (options) {
    const s = document.createElement("select");
    if (!value) {
      const ph = document.createElement("option");
      ph.value = ""; ph.textContent = "— choose —"; ph.selected = true;
      s.append(ph);
    }
    options.forEach((o) => { const op = document.createElement("option"); op.value = o; op.textContent = o; if (o === value) op.selected = true; s.append(op); });
    s.onchange = () => onChange(s.value);
    l.append(s);
  } else {
    const i = Object.assign(document.createElement("input"), { value: value ?? "" });
    i.onchange = () => onChange(i.value);
    l.append(i);
  }
  return l;
}

// A text input that looks like plain text until hovered or focused — for
// names and descriptions edited in place. Saves on change (blur/Enter);
// Escape reverts.
function inlineEdit(value, onSave, { multiline = false, placeholder = "", style = "" } = {}) {
  const i = document.createElement(multiline ? "textarea" : "input");
  i.className = "inline-edit"; i.value = value || ""; i.placeholder = placeholder;
  if (multiline) i.rows = 1;
  if (style) i.style.cssText = style;
  i.title = "Click to edit";
  let saved = i.value;
  i.onkeydown = (e) => {
    if (e.key === "Escape") { i.value = saved; i.blur(); }
    else if (e.key === "Enter" && !multiline) i.blur();
  };
  i.onchange = async () => {
    const v = i.value.trim();
    if (v === saved.trim()) return;
    try { await onSave(v); saved = v; } catch (e) { i.value = saved; fail(e); }
  };
  return i;
}

// Identity Vault. Real files, real approval state, and a write path that
// mirrors how Shawn actually generates references today: Nano Banana writes
// to the global generated_imgs/ inbox, and a keeper gets promoted into this
// production's 02_assets/ folder under a proper name.
const IDENTITY_HOLD_TEMPLATE =
  "Keep this exact [character]: identical face, bone structure, eyes, hairstyle, [wardrobe items]. Do not change their appearance or wardrobe in any way.";


function assetTypeOrder() {
  const known = ["character", "location", "prop"];
  // Anything already in the data with an unexpected type still gets a section.
  const extra = [...new Set(EP.assets.map((a) => a.type))].filter((t) => !known.includes(t));
  return [...known, ...extra];
}

// Group by (type, name) so multi-angle references (front/3q/profile/back) for
// the same character render as one card with a strip of angles, matching how
// scalist-templates.md actually organizes a turnaround set.
function groupAssets(assets) {
  const map = new Map();
  for (const a of assets) {
    const key = `${a.type}:${a.name.trim().toLowerCase()}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(a);
  }
  return [...map.values()];
}

// "Find new images": images in the series' asset folders (shared
// _RedClover/02_assets/ and every episode's 02_assets/) that this vault doesn't
// use yet. Nothing is linked automatically — each image gets its own Add, as a
// new card or as another angle on an existing card. Stays open across the
// re-render that follows an Add, so several can be filed in a row.
let NEW_IMAGES_OPEN = false;

async function renderNewImages(card) {
  const host = card.querySelector("#newImagesPanel");
  if (!host) return;
  host.innerHTML = "";
  if (!NEW_IMAGES_OPEN) return;
  const box = el("div", "card"); box.style.cssText = "margin:10px 0;background:var(--panel2)";
  box.append(Object.assign(el("div", "mini"), { textContent: "Looking through the asset folders…" }));
  host.append(box);
  let files;
  try {
    const q = `dir=${encodeURIComponent(EP.dir)}${SERIES_DIR ? `&seriesDir=${encodeURIComponent(SERIES_DIR)}` : ""}`;
    ({ files } = await api(`/api/episode/new-asset-images?${q}`));
  } catch (e) { box.innerHTML = ""; fail(e); return; }
  box.innerHTML = "";
  const head = el("div", "row");
  head.append(Object.assign(el("b"), { textContent: files.length ? `${files.length} image${files.length === 1 ? "" : "s"} not in the vault yet` : "Every image in the asset folders is already in the vault.", style: "flex:1" }));
  const close = el("button", null, "Close");
  close.onclick = () => { NEW_IMAGES_OPEN = false; host.innerHTML = ""; };
  head.append(close);
  box.append(head);
  if (!files.length) return;

  const groups = groupAssets(EP.assets);
  const grid = el("div"); grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;margin-top:10px";
  for (const f of files) grid.append(newImageRow(f, groups, card));
  box.append(grid);
}

function guessAssetName(fileName) {
  return fileName.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
}

function newImageRow(f, groups, card) {
  const row = el("div", "asset"); row.style.cssText = "display:flex;flex-direction:column;gap:6px;padding:8px";
  const img = Object.assign(document.createElement("img"), { src: mediaURL(f.path, 400), loading: "lazy", title: f.path });
  img.style.cssText = "width:100%;height:150px;object-fit:contain;background:#000;border-radius:4px;cursor:zoom-in";
  img.onclick = () => window.open(mediaURL(f.path), "_blank");
  row.append(img);
  row.append(Object.assign(el("div", "mini"), { textContent: `${f.name} · ${f.folder}`, style: "word-break:break-word" }));

  const target = document.createElement("select");
  const optNew = document.createElement("option"); optNew.value = ""; optNew.textContent = "New card…"; target.append(optNew);
  groups.forEach((g, i) => {
    const o = document.createElement("option"); o.value = String(i);
    o.textContent = g.some((a) => !a.path) ? `Fill empty slot: ${g[0].name} (${g[0].type})` : `Add angle to: ${g[0].name} (${g[0].type})`; target.append(o);
  });
  const typeSel = document.createElement("select");
  ["character", "location", "prop"].forEach((t) => { const o = document.createElement("option"); o.value = t; o.textContent = t; typeSel.append(o); });
  if (/location|plate|exterior|interior|street|alley|square|workshop|house/i.test(f.path)) typeSel.value = "location";
  else if (/prop/i.test(f.path)) typeSel.value = "prop";
  const nameI = Object.assign(document.createElement("input"), { value: guessAssetName(f.name), placeholder: "Name" });
  const angleI = Object.assign(document.createElement("input"), { placeholder: "Angle (e.g. Face Closeups, 9:16, day)" });
  if (/face|closeup|close-up/i.test(f.name)) angleI.value = "Face Closeups";
  else if (/9[:x ]?16|916/i.test(f.name)) angleI.value = "9:16";
  const newOnly = el("div"); newOnly.style.cssText = "display:flex;gap:6px";
  newOnly.append(typeSel, nameI);
  target.onchange = () => { newOnly.style.display = target.value === "" ? "flex" : "none"; };
  row.append(target, newOnly, angleI);

  const add = el("button", "primary", "Add to vault");
  add.onclick = async () => {
    const g = target.value === "" ? null : groups[Number(target.value)];
    const type = g ? g[0].type : typeSel.value;
    const name = g ? g[0].name : nameI.value.trim();
    if (!name) { nameI.focus(); return; }
    // A new angle carries its card's identity hold (holds dedupe in prompts);
    // a new character card starts from the template, like "+ New asset".
    const hold = g ? (g.find((a) => (a.identityHold || "").trim())?.identityHold || "")
      : type === "character" ? IDENTITY_HOLD_TEMPLATE : "";
    // A card whose slot has no image yet (a record made before its picture
    // existed) gets the image in THAT slot, not a second angle beside it —
    // shots already point at the empty slot's id.
    const empty = g ? g.find((a) => !a.path) : null;
    add.disabled = true;
    try {
      if (empty) {
        const patch = { path: f.path };
        if (angleI.value.trim() && !empty.angle) patch.angle = angleI.value.trim();
        await post("/api/episode/asset/update", { dir: EP.dir, assetId: empty.id, patch });
      } else await post("/api/episode/asset", { dir: EP.dir, asset: { type, name, angle: angleI.value.trim(), path: f.path, identityHold: hold } });
      await reloadEpisode();
      flashNote(`Added ${f.name} to ${name}.`);
    } catch (e) { fail(e); add.disabled = false; }
  };
  row.append(add);
  return row;
}



function labeled(label, inputEl) {
  const l = el("label", "f");
  l.append(el("span", null, label));
  l.append(inputEl);
  return l;
}



function assetEditor(asset, group) {
  const box = el("div"); box.style.cssText = "border-top:1px solid var(--line);padding-top:8px;margin-top:6px";

  const nameI = Object.assign(document.createElement("input"), { value: asset.name });
  const angleI = Object.assign(document.createElement("input"), { value: asset.angle || "" });
  const grid = el("div", "grid g2");
  grid.append(labeled("Name", nameI), labeled("Angle", angleI));
  box.append(grid);

  // Category + tags apply to the WHOLE card (every angle), unlike name/angle.
  const typeSel = document.createElement("select");
  assetTypeOrder().forEach((t) => { const o = document.createElement("option"); o.value = t; o.textContent = t; typeSel.append(o); });
  typeSel.value = asset.type;
  const tagsI = Object.assign(document.createElement("input"), { value: [...new Set(group.flatMap((a) => a.tags || []))].join(", "), placeholder: "comma-separated, e.g. workshop, heist crew" });
  const orgGrid = el("div", "grid g2");
  orgGrid.append(labeled(group.length > 1 ? `Category (all ${group.length} angles)` : "Category", typeSel), labeled("Tags", tagsI));
  box.append(orgGrid);

  const holdT = Object.assign(document.createElement("textarea"), { rows: 2, value: asset.identityHold || "" });
  box.append(labeled("Identity hold", holdT));

  const voiceI = Object.assign(document.createElement("input"), { value: asset.voice || "" });
  box.append(labeled("Voice trait (used in dialogue prompts)", voiceI));

  const appRow = el("label", "f"); appRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-top:6px";
  const appCb = Object.assign(document.createElement("input"), { type: "checkbox", checked: !!asset.approved });
  appCb.style.width = "auto";
  appRow.append(appCb, Object.assign(el("span"), { textContent: "Approved — counts as standing canon in the new-asset audit" }));
  box.append(appRow);

  const btnRow = el("div", "row"); btnRow.style.marginTop = "8px";
  const save = el("button", "primary", "Save");
  save.onclick = async () => {
    save.disabled = true;
    try {
      await post("/api/episode/asset/update", { dir: EP.dir, assetId: asset.id, patch: { name: nameI.value.trim(), angle: angleI.value.trim(), identityHold: holdT.value.trim(), voice: voiceI.value.trim(), approved: appCb.checked } });
      const tags = tagsI.value.split(",");
      await post("/api/episode/asset/organize", { dir: EP.dir, assetIds: group.map((a) => a.id), patch: { type: typeSel.value, tags } });
      await reloadEpisode();
    } catch (e) { fail(e); save.disabled = false; }
  };
  const del = el("button", null, group.length > 1 ? "Delete this angle" : "Delete");
  del.onclick = async () => {
    const what = group.length > 1 ? `this angle of "${asset.name}"${asset.angle ? ` (${asset.angle})` : ""}? Shots using it keep the card's other angles.` : `"${asset.name}"?`;
    if (!confirm(`Delete ${what} This only removes the record — the file stays on disk.`)) return;
    try { await post("/api/episode/asset/delete", { dir: EP.dir, assetId: asset.id }); await reloadEpisode(); } catch (e) { fail(e); }
  };
  btnRow.append(save, del);
  box.append(btnRow);

  box.append(Object.assign(el("div", "mini"), { textContent: "Attach an image to this asset:", style: "margin-top:10px" }));
  box.append(imageSourcePicker({
    onPickInbox: async (file) => {
      try {
        const destSub = `02_assets/${asset.type}s`;
        const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
        const filename = `${slugify(asset.name)}${asset.angle ? `_${slugify(asset.angle)}` : ""}.${ext}`;
        const { path: newPath } = await post("/api/media/promote", { source: file.name, fromInbox: true, dir: EP.dir, destSub, filename });
        await post("/api/episode/asset/update", { dir: EP.dir, assetId: asset.id, patch: { path: newPath } });
        await reloadEpisode();
      } catch (e) { fail(e); }
    },
    onPickDirect: async (path_) => {
      try {
        await post("/api/episode/asset/update", { dir: EP.dir, assetId: asset.id, patch: { path: path_ } });
        await reloadEpisode();
      } catch (e) { fail(e); }
    },
    uploadDestSub: `02_assets/${asset.type}s`,
  }));

  return box;
}

const slugify = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");


// The wide picker: search THIS project's own files first (everything already
// under 02_assets/ and 03_storyboard/), fall back to the shared cross-project
// generated_imgs/ inbox (filterable), or type a project-relative path when
// neither browse turns it up. Used anywhere an empty image slot needs
// filling — the Identity Vault and, via shotRefsPicker, a shot's references —
// instead of each place defaulting to "whatever's newest in the inbox."
//
// `onPickInbox(file)` gets an inbox file (needs a promote/copy step — the
// caller decides the destination). `onPickDirect(path, name)` gets a path
// already inside the project (attach as-is, nothing to copy).
// Confirms a project-relative path actually resolves to a loadable image
// before anything is attached to it — the fix for a typed/uploaded path
// silently "succeeding" and then showing nothing. Resolves true/false; never
// throws (a broken image is a normal outcome here, not an error).
function verifyImageLoads(path_) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = mediaURL(path_, 40);
  });
}

// `uploadDestSub`: where a browser-uploaded file lands inside the episode
// (the caller knows its own naming convention — e.g. the Identity Vault
// wants `02_assets/<type>s`); defaults to a generic uploads bucket.
function imageSourcePicker({ onPickInbox, onPickDirect, uploadDestSub = "02_assets/uploads" }) {
  const wrap = el("div");
  const tabs = el("div", "row"); tabs.style.flexWrap = "wrap";
  const tUpload = el("button", null, "Upload from your computer");
  const tProject = el("button", null, "This project");
  const tInbox = el("button", null, "Generated images (all projects)");
  const tPath = el("button", null, "Type a path");
  tabs.append(tUpload, tProject, tInbox, tPath);
  wrap.append(tabs);
  const host = el("div"); host.style.marginTop = "6px"; wrap.append(host);
  const setActive = (btn) => { [tUpload, tProject, tInbox, tPath].forEach((b) => { b.className = "pill" + (b === btn ? " on" : ""); }); };

  // The real fix for "forced to type a path instead of a proper picker": a
  // native <input type=file> opens the OS's own file dialog and can browse
  // anywhere on disk. Browsers deliberately don't expose a picked file's
  // filesystem path (Electron aside), so the bytes are uploaded instead —
  // functionally the same outcome (the file ends up in the project) without
  // needing a path at all.
  const showUpload = () => {
    setActive(tUpload); host.innerHTML = "";
    const fileI = Object.assign(document.createElement("input"), { type: "file", accept: "image/*" });
    const status = el("div", "mini"); status.style.margin = "6px 0";
    fileI.onchange = async () => {
      const file = fileI.files && fileI.files[0];
      if (!file) return;
      status.textContent = "Uploading…"; status.style.color = "";
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => reject(new Error("couldn't read that file"));
          r.readAsDataURL(file);
        });
        const dataBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        const { path: newPath } = await post("/api/media/upload", {
          dir: EP.dir, destSub: uploadDestSub, filename: file.name, dataBase64,
        });
        status.textContent = "";
        onPickDirect(newPath, file.name);
      } catch (e) {
        status.textContent = e.message || String(e);
        status.style.color = "#e06a6a";
      }
    };
    host.append(fileI); host.append(status);
  };

  const showProject = async () => {
    setActive(tProject); host.innerHTML = "Loading…";
    try {
      const { files } = await api(`/api/episode/project-media?dir=${encodeURIComponent(EP.dir)}`);
      host.innerHTML = "";
      host.append(projectMediaBrowser(files, (f) => onPickDirect(f.path, f.name)));
    } catch (e) { host.innerHTML = ""; fail(e); }
  };
  const showInbox = () => {
    setActive(tInbox); host.innerHTML = "";
    host.append(inboxPickerFiltered(onPickInbox));
  };
  const showPath = () => {
    setActive(tPath); host.innerHTML = "";
    const row = el("div", "row");
    const i = Object.assign(document.createElement("input"), { placeholder: "e.g. Fashion Heist/S1E1_v2/03_storyboard/some_file.png" });
    i.style.flex = "1";
    const go = el("button", "primary", "Use this file");
    const status = el("div", "mini"); status.style.margin = "4px 0";
    go.onclick = async () => {
      const p = i.value.trim().replace(/^\/+/, "");
      if (!p) return;
      status.textContent = "Checking…"; status.style.color = "";
      go.disabled = true;
      const ok = await verifyImageLoads(p);
      go.disabled = false;
      if (!ok) {
        status.textContent = `No image found at "${p}" — check the path is relative to the library root and try again.`;
        status.style.color = "#e06a6a";
        return;
      }
      status.textContent = "";
      onPickDirect(p, p.split("/").pop());
    };
    row.append(i, go);
    host.append(Object.assign(el("div", "mini"), { textContent: "Relative to the library root shown on the Library screen (e.g. \"Fashion Heist/S1E1_v2/03_storyboard/...\").", style: "margin-bottom:4px" }));
    host.append(row); host.append(status);
  };
  tUpload.onclick = showUpload; tProject.onclick = showProject; tInbox.onclick = showInbox; tPath.onclick = showPath;
  showUpload();
  return wrap;
}

// This episode's own media (02_assets/ recursive + 03_storyboard/), grouped
// by where it lives, so picking a reference never means scrolling every
// production's inbox to find something that was already right here.
function projectMediaBrowser(files, onPick) {
  const wrap = el("div");
  if (!files.length) { wrap.append(Object.assign(el("div", "empty"), { textContent: "No images in this episode's 02_assets/ or 03_storyboard/ yet." })); return wrap; }
  const bySource = new Map();
  files.forEach((f) => {
    const key = f.source || "other";
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(f);
  });
  const sources = [...bySource.keys()].sort();
  sources.forEach((source) => {
    const group = el("details"); group.open = sources.length <= 4;
    group.append(Object.assign(el("summary"), { textContent: `${source} (${bySource.get(source).length})` }));
    const grid = el("div", "assets"); grid.style.marginTop = "6px";
    bySource.get(source).forEach((f) => {
      const cell = el("div", "asset"); cell.style.cursor = "pointer";
      if (f.kind === "image") {
        const img = document.createElement("img"); img.src = mediaURL(f.path, 200); img.style.cssText = "width:100%;height:80px;object-fit:cover;display:block";
        cell.append(img);
      } else {
        cell.append(Object.assign(el("div", "noimg"), { textContent: f.name }));
      }
      cell.append(Object.assign(el("div", "an mini"), { textContent: f.name }));
      cell.onclick = () => onPick(f);
      grid.append(cell);
    });
    group.append(grid);
    wrap.append(group);
  });
  return wrap;
}

// Patch one shot field, keep the local object in sync, and regenerate the
// derived prompts (they're built server-side from label/action/subjects/etc,
// so any edit here would otherwise leave the prompt boxes showing stale text).
// Anchored on this shot (see withShotAnchor) so editing a field deep in the
// Shots list doesn't scroll you away from the shot you're editing.
function shotField(shot, key) {
  return (v) => {
    shot[key] = v;
    post("/api/episode/shot/update", { dir: EP.dir, shotId: shot.id, patch: { [key]: v } })
      .then(() => refreshPrompts(shot.id))
      .catch(fail);
  };
}

function beatField(shot, beat, key) {
  return (v) => {
    beat[key] = v;
    post("/api/episode/beat/update", { dir: EP.dir, shotId: shot.id, beatId: beat.id, patch: { [key]: v } })
      .then(() => refreshPrompts(shot.id))
      .catch(fail);
  };
}

// Inserted right after `shot` in the SAME scene, inheriting its INT/EXT,
// location and time (the surrounding facts of the scene) but nothing else —
// label/action/camera start blank, ready for what this new shot actually is.
// The server relabels shotCode for the whole scene, so what was 3b becomes
// 3c automatically; just reload and it's already in order.
// A shot just added from the Production board: select it and put the cursor in
// its name field (the inspector heading), so naming it is the obvious next step.
let NAME_FOCUS = null;
function openNewShot(made) {
  if (!made || !made.id || STAGE !== "prod") return;
  SEL_SHOT = made.id; NAME_FOCUS = made.id;
  if (made.sceneNum != null) CUR_SCENE = String(made.sceneNum);
}

async function insertShotAfter(shot) {
  const idx = (EP.shots || []).findIndex((s) => s.id === shot.id);
  const draft = {
    sceneId: shot.sceneId, sceneNum: shot.sceneNum,
    intext: shot.intext, loc: shot.loc, time: shot.time, location: shot.location,
  };
  try {
    const made = await post("/api/episode/shot", { dir: EP.dir, shot: draft, index: idx + 1 });
    PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`);
    openNewShot(made);
    await reloadEpisode();
  } catch (e) { fail(e); }
}

// The only way to put a shot at the TOP of a scene (e.g. an establishing
// shot ahead of 2a) — "after" can't reach that slot.
async function insertShotBefore(shot) {
  const idx = (EP.shots || []).findIndex((s) => s.id === shot.id);
  const draft = {
    sceneId: shot.sceneId, sceneNum: shot.sceneNum,
    intext: shot.intext, loc: shot.loc, time: shot.time, location: shot.location,
  };
  try {
    await post("/api/episode/shot", { dir: EP.dir, shot: draft, index: idx });
    PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`);
    await reloadEpisode();
  } catch (e) { fail(e); }
}

// Every scene in script order with its shots — INCLUDING scenes that have no
// shots yet, which would otherwise be invisible and unreachable (every other
// add button hangs off an existing shot).
function sceneGroups() {
  const byNum = new Map();
  const key = (n) => String(n ?? "");
  (EP.scenes || []).forEach((sc) => byNum.set(key(sc.number), { num: key(sc.number), scene: sc, shots: [] }));
  (EP.shots || []).forEach((sh) => {
    const k = key(sh.sceneNum);
    if (!byNum.has(k)) byNum.set(k, { num: k, scene: null, shots: [] });
    byNum.get(k).shots.push(sh);
  });
  const n = (k) => (isNaN(Number(k)) ? Infinity : Number(k));
  return [...byNum.values()].sort((a, b) => n(a.num) - n(b.num));
}

// "X" is the Archive: shots that are out of the edit, kept so they can come
// back. Organize fills it from a Resolve cut; Shawn can also drag a shot onto
// it (or pick "Archive" in Move to scene…). The timeline, every export, sound
// placement and the gates skip it (shot.cutFromEdit).
const CUT_SCENE = "X";

function sceneHeading(g) {
  if (g.num === CUT_SCENE) return "Archive — not in the edit, kept so a shot can be restored";
  const h = g.scene && g.scene.heading && g.scene.heading !== "(no slugline)" ? g.scene.heading : "";
  // After Organize the number is the cut's; the screenplay's is a just-in-case.
  const script = g.scene && g.scene.scriptNumber && String(g.scene.scriptNumber) !== g.num ? ` (script ${g.scene.scriptNumber})` : "";
  return `Scene ${g.num}${script}${h ? ` — ${h}` : ""}`;
}

// First shot for a scene with none: placed after every shot of earlier
// scenes, and seeded from the scene's own slugline.
async function addShotToScene(g) {
  const target = Number(g.num);
  let at = (EP.shots || []).findIndex((sh) => Number(sh.sceneNum) > target);
  if (at < 0) at = (EP.shots || []).length;
  const sc = g.scene || {};
  const draft = { sceneId: sc.id, sceneNum: g.num, intext: sc.intext, loc: sc.loc, time: sc.time, location: sc.loc };
  try {
    const made = await post("/api/episode/shot", { dir: EP.dir, shot: draft, index: at });
    PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`);
    openNewShot(made);
    await reloadEpisode();
  } catch (e) { fail(e); }
}

function emptySceneRow(g) {
  const r = el("div", "eprow");
  r.append(Object.assign(el("div", "mini"), { textContent: "No shots in this scene yet.", style: "flex:1" }));
  const b = el("button", null, "+ Add shot");
  b.title = `Add the first shot to scene ${g.num}`;
  b.onclick = () => addShotToScene(g);
  r.append(b);
  return r;
}

// idPrefix is set only at the ONE call site the sidebar's scene links target
// (the Shots list) — sceneHeader is also used in the Storyboard panel's own
// scene grouping, and both must not claim the same id.
const sceneHeader = (g, idPrefix) => {
  const d = Object.assign(el("div"), { textContent: sceneHeading(g), style: "margin:14px 0 2px;font-size:12px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:.04em" });
  if (idPrefix) d.id = `${idPrefix}-scene-${g.num}`;
  return d;
};

const firstInScene = (shot) => {
  const i = (EP.shots || []).findIndex((s) => s.id === shot.id);
  return i === 0 || EP.shots[i - 1].sceneNum !== shot.sceneNum;
};

// A <select> on each storyboard: move it to another shot in the scene, or out
// into a new shot of its own. This is how a frame changes its shot number.
function moveToSelect(shot, beat) {
  const sel = document.createElement("select");
  sel.style.cssText = "width:auto;padding:1px 6px;font-size:11px";
  sel.title = "Move this storyboard to a different shot";
  const opt = (value, text) => { const o = document.createElement("option"); o.value = value; o.textContent = text; sel.append(o); };
  opt("", "Move to…");
  opt("__new", `New shot after ${shot.sceneNum}${shot.shotCode}`);
  (EP.shots || []).filter((x) => x.sceneNum === shot.sceneNum && x.id !== shot.id).forEach((x) => {
    opt(x.id, `${x.sceneNum}${x.shotCode} — ${(x.label || "(untitled)").slice(0, 40)}`);
  });
  sel.onchange = async () => {
    const v = sel.value; if (!v) return;
    try {
      const r = await post("/api/episode/beat/move", v === "__new"
        ? { dir: EP.dir, shotId: shot.id, beatId: beat.id, newShot: true, label: shot.label }
        : { dir: EP.dir, shotId: shot.id, beatId: beat.id, toShotId: v });
      PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`);
      await reloadEpisode();
      if (r && r.shotCode) flashNote(`Moved to shot ${r.shotCode}${r.sourceRemoved ? ` — the old shot had nothing left and was removed` : ""}. Undo reverses it.`);
    } catch (e) { sel.value = ""; fail(e); }
  };
  return sel;
}

async function grabFrame(shot, beat, take) {
  try {
    await post("/api/episode/beat/frame-from-take", { dir: EP.dir, shotId: shot.id, beatId: beat.id, versionId: take.id });
    await reloadEpisode(shot.id);
    flashNote(`Storyboard ${shot.sceneNum}${shot.shotCode} · ${beat.role} set from the video — approve it when it looks right.`);
  } catch (e) { fail(e); }
}

// "Move to…" on a take: a shot selects ONE take, so two clips that are really
// two shots need two shots. Any shot in the episode, or a new shot right
// after this one (named after the take's label).
function takeMoveSelect(v) {
  const from = (EP.shots || []).find((s) => (s.versions || []).some((x) => x.id === v.id));
  const sel = document.createElement("select");
  sel.style.cssText = "width:auto;max-width:190px;padding:3px 6px;font-size:12px";
  sel.title = "Move this take to a different shot, or make it its own new shot";
  const opt = (value, text, parent = sel) => { const o = document.createElement("option"); o.value = value; o.textContent = text; parent.append(o); };
  opt("", "Move to…");
  if (from) opt("__new", `New shot after ${from.sceneNum}${from.shotCode}`);
  sceneGroups().forEach((g) => {
    if (!g.shots.length) return;
    const og = document.createElement("optgroup"); og.label = `Scene ${g.num}`;
    g.shots.filter((x) => x !== from).forEach((x) => opt(x.id, `${x.sceneNum}${x.shotCode} — ${(x.label || "(untitled)").slice(0, 40)}`, og));
    sel.append(og);
  });
  sel.onchange = async () => {
    const val = sel.value; if (!val) return;
    try {
      const r = await post("/api/episode/version/move", val === "__new"
        ? { dir: EP.dir, versionId: v.id, newShot: true }
        : { dir: EP.dir, versionId: v.id, toShotId: val });
      PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`);
      await reloadEpisode(r.shotId);
      flashNote(`Take moved to shot ${r.shotCode}. Undo reverses it.`);
    } catch (e) { sel.value = ""; fail(e); }
  };
  return sel;
}

async function moveShot(shot, by) {
  try {
    await post("/api/episode/shot/move", { dir: EP.dir, shotId: shot.id, by });
    PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`);
    await reloadEpisode();
  } catch (e) { fail(e); }
}

// Move this whole shot into a DIFFERENT scene — for a shot drafted under the
// wrong scene number, or one that turns out to belong inside an existing
// scene rather than opening its own (Sept 2026 — the "1a" case: a lone
// establishing shot that was really the first shot of the next scene over).
// Same optgroup-per-scene pattern as takeMoveSelect, just scoped to scenes
// instead of shots within one scene.
function shotSceneMoveSelect(shot) {
  const sel = document.createElement("select");
  sel.style.cssText = "width:auto;max-width:180px;padding:3px 6px;font-size:12px";
  sel.title = "Move this whole shot into a different scene (renumbers both scenes)";
  const opt = (value, text, parent = sel) => { const o = document.createElement("option"); o.value = value; o.textContent = text; parent.append(o); };
  const restoring = shot.sceneNum === CUT_SCENE;
  opt("", restoring ? "Restore to scene…" : "Move to scene…");
  if (restoring) sel.title = `Cut from edit${shot.cutFromEdit ? ` (was ${shot.cutFromEdit.fromCode})` : ""}. Restore it into a scene.`;
  if (!restoring) opt(`${CUT_SCENE}|end`, "Archive (not in the edit)");
  sceneGroups().forEach((g) => {
    if (g.num === shot.sceneNum || g.num === CUT_SCENE) return;
    const og = document.createElement("optgroup"); og.label = sceneHeading(g);
    opt(`${g.num}|start`, "— start of scene", og);
    opt(`${g.num}|end`, "— end of scene", og);
    sel.append(og);
  });
  sel.onclick = (e) => e.stopPropagation(); // don't toggle the shot <details>
  sel.onchange = async () => {
    const val = sel.value; if (!val) return;
    const [targetSceneNum, position] = val.split("|");
    try {
      const r = await post("/api/episode/shot/move-to-scene", { dir: EP.dir, shotId: shot.id, targetSceneNum, position });
      PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`);
      await reloadEpisode();
      flashNote(r.sceneNum === CUT_SCENE ? `Archived — out of the edit and every export. Restore it from the Archive. Undo reverses it.` : `Moved to scene ${r.sceneNum} as ${r.sceneNum}${r.shotCode}. Undo reverses it.`);
    } catch (e) { sel.value = ""; fail(e); }
  };
  return sel;
}

// "This scene and every one after it were all off by one" — closes a gap
// (delta -1, after retiring an empty scene) or opens a slot for a new scene
// mid-episode (delta +1). Lives on the Shots panel's scene header since
// that's where the rest of the shot-list's structural editing lives.
function sceneRenumberControls(g) {
  const row = el("div", "row"); row.style.cssText = "margin:0 0 8px;gap:6px;align-items:center";
  row.append(Object.assign(el("span", "mini"), { textContent: `Renumber scene ${g.num} & later:` }));
  const mkBtn = (label, delta) => {
    const b = el("button", null, label);
    b.title = delta < 0
      ? `Renumber scene ${g.num} and every later scene down by 1 — for after retiring an empty scene above it`
      : `Renumber scene ${g.num} and every later scene up by 1 — opens a free slot at scene ${g.num}`;
    b.onclick = async () => {
      const verb = delta < 0 ? "down" : "up";
      const after = Number(g.num) + delta;
      if (Number.isNaN(after) || !confirm(`Renumber scene ${g.num} and every scene after it ${verb} by 1?\n\nScene ${g.num} becomes ${after}, and so on for every later scene — every shot in those scenes moves with its scene. One undo step for the whole batch.`)) return;
      try {
        const r = await post("/api/episode/scenes/shift", { dir: EP.dir, fromSceneNum: g.num, delta });
        await reloadEpisode();
        flashNote(`Renumbered ${r.shifted} scene${r.shifted === 1 ? "" : "s"}. Undo reverses it.`);
      } catch (e) { fail(e); }
    };
    return b;
  };
  row.append(mkBtn("−1", -1));
  row.append(mkBtn("+1", 1));
  return row;
}

function flashNote(text) {
  const n = Object.assign(el("div", "flash"), { textContent: text });
  document.body.append(n);
  setTimeout(() => n.remove(), 5000);
}

async function deleteShot(shot) {
  const code = `${shot.sceneNum}${shot.shotCode}`;
  const frames = (shot.beats || []).filter((b) => b.keyframe).length;
  const ok = confirm(`Delete the WHOLE shot ${code} — "${shot.label || shot.action || "(untitled)"}"?\n\nThis deletes ${frames} storyboard frame${frames === 1 ? "" : "s"} and renumbers the rest of the scene. Images and video takes stay on disk. Undo brings it back.\n\n(To delete just one storyboard, use "Delete storyboard" on that row instead.)`);
  if (!ok) return;
  try {
    // Anchor on the neighbour that stays put (next shot, else previous) so the
    // page doesn't leap by the height of everything just removed.
    const order = EP.shots || [];
    const at = order.findIndex((x) => x.id === shot.id);
    const neighbour = order[at + 1] || order[at - 1] || null;
    await post("/api/episode/shot/delete", { dir: EP.dir, shotId: shot.id });
    await reloadEpisode(neighbour ? neighbour.id : undefined);
  } catch (e) { fail(e); }
}

// A beat's frame name/number is always derived from its live position, so
// nothing needs relabeling here the way shotCode does — insert/delete and
// the board panel already reads the new order on next render.
// The new beat is a "mid", so after an "end" beat it goes BEFORE it instead —
// a mid still after the end frame would be out of order.
async function insertBeatAfter(shot, beat) {
  const idx = (shot.beats || []).findIndex((b) => b.id === beat.id);
  const at = beat.role === "end" ? idx : idx + 1;
  try {
    await post("/api/episode/beat", { dir: EP.dir, shotId: shot.id, beat: { role: "mid", keyframe: true }, index: at });
    PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`);
    await reloadEpisode(shot.id);
  } catch (e) { fail(e); }
}

async function deleteBeat(shot, beat) {
  const ok = confirm(`Delete this beat — "${beat.desc || "(no description)"}"?\n\nAny still already generated for it stays on disk (only the record is removed). This can't be undone.`);
  if (!ok) return;
  try {
    await post("/api/episode/beat/delete", { dir: EP.dir, shotId: shot.id, beatId: beat.id });
    await reloadEpisode(shot.id);
  } catch (e) { fail(e); }
}

function shotBlock(shot) {
  const p = (PROMPTS.shots || []).find((x) => x.id === shot.id) || { beats: [] };
  const d = el("details", "shot");
  d.dataset.shotId = shot.id; // scroll anchor across re-renders — see withShotAnchor
  d.open = OPEN_SHOTS.has(shot.id);
  d.ontoggle = () => { if (d.open) OPEN_SHOTS.add(shot.id); else OPEN_SHOTS.delete(shot.id); };
  const sm = el("summary");
  sm.append(el("div", "code", (shot.sceneNum || "") + (shot.shotCode || "")));
  sm.append(el("div", "lbl", shot.label || shot.action || "(untitled shot)"));
  sm.append(Object.assign(el("span", "pill"), { textContent: shot.size || "" }));
  sm.append(Object.assign(el("span", "pill"), { textContent: `${shot.beats.length} beat${shot.beats.length === 1 ? "" : "s"}` }));
  const stills = shot.beats.filter((b) => b.keyframe).length;
  sm.append(Object.assign(el("span", "pill" + (stills ? "" : " warn")), { textContent: `${stills} still${stills === 1 ? "" : "s"}` }));
  // Once a take is actually selected, show ITS real requested duration
  // (Generate's own duration dropdown, `version.seconds`) instead of the
  // beat-timing estimate — Shawn wants the rough-assembly length built from
  // what was actually generated, not the pre-generation guess (Sept 2026).
  // Falls back to the estimate for anything not yet generated, since that's
  // still the only number available before a take exists. `seconds` isn't
  // uniformly a number across drivers — an imported take stores it as a
  // string (server/index.js addImportedTake) — so this always coerces
  // before use rather than trusting the type.
  const primaryVersion = (shot.versions || []).find((v) => v.id === (shot.selectedVersions || [])[0]);
  const primarySec = primaryVersion ? Number(primaryVersion.seconds) : NaN;
  const shownSec = Number.isFinite(primarySec) ? primarySec : (p.durationSec || 0);
  if (shot.remaster) {
    const r = shot.remaster;
    sm.append(Object.assign(el("span", "pill"), {
      textContent: r.targetSeconds ? `target ${r.targetSeconds.toFixed(1)}s` : "no target",
      title: r.targetSeconds
        ? `The cut uses ${r.spanSec.toFixed(2)} s of this shot; ${r.handlesSec} s handle each end. Was ${r.sourceCode} in the proof of concept.`
        : `Added back — not in the cut, so pick its duration by hand. Was ${r.sourceCode} in the proof of concept.`,
    }));
  }
  // In a remaster, the target pill replaces the beat estimate until a take exists.
  if (!(shot.remaster && !Number.isFinite(primarySec))) sm.append(Object.assign(el("span", "pill"), {
    textContent: `${shownSec.toFixed(1)}s`,
    title: Number.isFinite(primarySec) ? "Actual duration requested for the selected take" : "Estimated from the shot's timing beats — nothing generated yet",
  }));

  // Progress at a glance — the same thing Approve/Select track elsewhere,
  // surfaced here so scanning the Shots list shows what's finished without
  // opening every card.
  const kfBeats = shot.beats.filter((b) => b.keyframe);
  const approvedKf = kfBeats.filter((b) => b.frame && b.frame.approved).length;
  const boardDone = kfBeats.length > 0 && approvedKf === kfBeats.length;
  sm.append(Object.assign(el("span", "pill" + (boardDone ? " ok" : kfBeats.length ? " warn" : "")), {
    textContent: kfBeats.length ? `board ${approvedKf}/${kfBeats.length}` : "no board",
  }));
  // Same fraction shape as the board pill above (selected/approved vs.
  // total) — a quick read of takes generated vs. takes actually chosen for
  // the cut, rather than a boolean "has video" (Sept 2026).
  const takeCount = (shot.versions || []).length;
  const selCount = (shot.selectedVersions || []).length;
  sm.append(Object.assign(el("span", "pill" + (selCount ? " ok" : takeCount ? " warn" : "")), {
    textContent: takeCount ? `${selCount}/${takeCount} clip${takeCount === 1 ? "" : "s"}` : "no video",
  }));
  // Add/delete live on the summary line so they work without expanding the
  // shot. Clicks must not also toggle the <details>.
  const act = el("span", "row-actions"); act.style.cssText = "margin:0 0 0 auto";
  const mk = (label, title, fn) => {
    const b = el("button", null, label); b.title = title;
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(); };
    act.append(b);
  };
  const code = `${shot.sceneNum}${shot.shotCode}`;
  if (firstInScene(shot)) mk("+ Shot before", `Add a new shot at the top of scene ${shot.sceneNum}, ahead of ${code}`, () => insertShotBefore(shot));
  mk("+ Shot after", `Add a new shot right after ${code} (later shots renumber)`, () => insertShotAfter(shot));
  mk("↑", "Move this shot up one place in the scene (renumbers)", () => moveShot(shot, -1));
  mk("↓", "Move this shot down one place in the scene (renumbers)", () => moveShot(shot, 1));
  act.append(shotSceneMoveSelect(shot));
  mk("Delete shot", `Delete shot ${code} and all its storyboards`, () => deleteShot(shot));
  act.lastChild.className = "danger";
  sm.append(act);
  d.append(sm);

  const body = el("div", "body");
  shotFieldsInto(body, shot, p);
  body.append(videoPromptSection(shot, p));
  body.append(blockingWidget(shot));
  body.append(videoGeneratePane(shot));
  d.append(body);
  return d;
}

// The shot's editable fields and beats — shared by the Clips stage's full
// shot block and the Board inspector's "Shot details" section.
function shotFieldsInto(body, shot, p) {
  const g1 = el("div", "grid g4");
  g1.append(field("INT/EXT", shot.intext, shotField(shot, "intext"), ["INT.", "EXT."]));
  g1.append(field("Location", shot.loc, shotField(shot, "loc")));
  g1.append(field("Time", shot.time, shotField(shot, "time"), ["DAY", "NIGHT", "DUSK", "DAWN", "CONTINUOUS"]));
  g1.append(field("Label", shot.label, shotField(shot, "label")));
  body.append(g1);

  const g2 = el("div", "grid g4");
  g2.append(field("Size", shot.size, shotField(shot, "size"), Object.keys(GRAMMAR.sizes || {})));
  g2.append(field("Angle", shot.angle, shotField(shot, "angle"), Object.keys(GRAMMAR.angles || {})));
  g2.append(field("Lens", shot.lens, shotField(shot, "lens"), Object.keys(GRAMMAR.lenses || {})));
  g2.append(field("Move", shot.move, shotField(shot, "move"), Object.keys(GRAMMAR.moves || {})));
  body.append(g2);

  const g3 = el("div", "grid g2");
  g3.append(field("Subjects", shot.subjects, shotField(shot, "subjects")));
  g3.append(field("Lighting", shot.lighting, shotField(shot, "lighting")));
  body.append(g3);

  const actionL = el("label", "f"); actionL.style.marginTop = "6px";
  actionL.append(el("span", null, "Action"));
  const actionT = Object.assign(document.createElement("textarea"), { value: shot.action || "", rows: 2 });
  actionT.onchange = () => shotField(shot, "action")(actionT.value);
  actionL.append(actionT); body.append(actionL);

  const g4 = el("div", "grid g2"); g4.style.marginTop = "6px";
  g4.append(field("Audio", shot.audio, shotField(shot, "audio")));
  g4.append(field("Notes", shot.notes, shotField(shot, "notes")));
  body.append(g4);

  body.append(Object.assign(el("div", "mini"), { textContent: p.frameBase || "", style: "margin:6px 0" }));

  p.beats.forEach((b, i) => {
    const beat = shot.beats[i] || {};
    const bd = el("div", "beat");
    const bh = el("div", "bh");
    bh.append(el("span", "role", b.role));
    bh.append(Object.assign(el("span"), { textContent: b.keyframe ? "keyframe · generates a still" : "timing beat · no still" }));
    bh.append(Object.assign(el("span"), { textContent: `${b.durationSec.toFixed(1)}s` }));
    if (b.frameName) bh.append(Object.assign(el("span", "mono"), { textContent: b.frameName }));
    const kfBtn = el("button", null, beat.keyframe ? "Make timing beat" : "Make keyframe");
    kfBtn.title = beat.keyframe
      ? "Stop generating a still for this beat — it leaves the storyboard"
      : "Generate a still for this beat — it goes back on the storyboard (any image it had is restored)";
    kfBtn.style.cssText = "padding:2px 7px;font-size:11px;margin-left:auto";
    kfBtn.onclick = async () => {
      try {
        await post("/api/episode/beat/update", { dir: EP.dir, shotId: shot.id, beatId: beat.id, patch: { keyframe: !beat.keyframe } });
        await reloadEpisode(shot.id);
      } catch (e) { fail(e); }
    };
    bh.append(kfBtn);
    const insBeatBtn = el("button", null, beat.role === "end" ? "+ Insert beat before" : "+ Insert beat after");
    insBeatBtn.style.cssText = "padding:2px 7px;font-size:11px";
    insBeatBtn.onclick = () => insertBeatAfter(shot, beat);
    bh.append(insBeatBtn);
    if (shot.beats.length > 1) {
      const delBeatBtn = el("button", null, "Delete beat");
      delBeatBtn.style.cssText = "padding:2px 7px;font-size:11px";
      delBeatBtn.onclick = () => deleteBeat(shot, beat);
      bh.append(delBeatBtn);
    }
    bd.append(bh);

    const descL = el("label", "f"); descL.style.margin = "4px 0";
    descL.append(el("span", null, "Beat description"));
    const descT = Object.assign(document.createElement("textarea"), { value: beat.desc || "", rows: 2 });
    descT.onchange = () => beatField(shot, beat, "desc")(descT.value);
    descL.append(descT); bd.append(descL);

    if (beat.dialogue) {
      const row = el("div", "grid g2");
      row.append(field("Dialogue delivery", beat.dialogue.delivery, (v) => beatField(shot, beat, "dialogue")({ ...beat.dialogue, delivery: v })));
      row.append(field("Dialogue line", beat.dialogue.line, (v) => beatField(shot, beat, "dialogue")({ ...beat.dialogue, line: v })));
      bd.append(row);
    }
    bd.append(field("SFX / beat audio", beat.audio, beatField(shot, beat, "audio")));
    // "no music" is a real, common state (music is usually added in post) —
    // shown explicitly rather than left blank so it reads as a choice, not a
    // gap. Typing "no music" (or clearing the field) saves null, same thing.
    bd.append(field("Music", beat.music || "no music", (v) => {
      const t = (v || "").trim();
      beatField(shot, beat, "music")(!t || t.toLowerCase() === "no music" ? null : t);
    }));
    body.append(bd);
  });
}

// Top-down 2D blocking: click a character or camera chip to select it, then
// click the stage to place it. Normalized 0..1 coordinates, so the diagram
// has no notion of real room size — it only exists to answer one question,
// which side of the axis is the camera on.
function blockingWidget(shot) {
  const box = el("div", "card"); box.style.cssText = "margin-top:10px;background:var(--panel2)";
  box.append(el("h3", null, "Blocking — top-down")); box.querySelector("h3").style.cssText = "font-size:12px;margin-bottom:6px";

  const charAssets = (shot.refs || [])
    .map((id) => (EP.assets || []).find((a) => a.id === id))
    .filter((a) => a && a.type === "character");

  if (!shot.blocking) {
    const n = charAssets.length || 1;
    shot.blocking = {
      chars: charAssets.map((a, i) => ({ key: a.id, name: a.name, x: (i + 1) / (n + 1), y: 0.55 })),
      camera: null,
    };
  }
  // A character referenced on the shot but missing from blocking (added after
  // blocking was first placed) gets seeded in rather than silently dropped.
  const haveKeys = new Set(shot.blocking.chars.map((c) => c.key));
  charAssets.forEach((a, i) => {
    if (!haveKeys.has(a.id)) shot.blocking.chars.push({ key: a.id, name: a.name, x: 0.5, y: 0.55 + (i + 1) * 0.001 });
  });

  const SIZE = 220;
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", SIZE); svg.setAttribute("height", SIZE);
  svg.setAttribute("viewBox", `0 0 ${SIZE} ${SIZE}`);
  svg.style.cssText = "background:#0a0d12;border:1px solid var(--line);border-radius:6px;cursor:crosshair";

  let active = shot.blocking.chars[0] ? { kind: "char", key: shot.blocking.chars[0].key } : { kind: "camera" };

  const chipRow = el("div", "row"); chipRow.style.margin = "6px 0";
  const mkChip = (label, on, onClick) => {
    const b = el("button", "pill" + (on ? " on" : "")); b.textContent = label; b.style.cursor = "pointer";
    b.onclick = onClick;
    return b;
  };

  function persist() {
    post("/api/episode/shot/update", { dir: EP.dir, shotId: shot.id, patch: { blocking: shot.blocking } }).catch(fail);
  }

  function redraw() {
    svg.innerHTML = "";
    // axis line between the first two characters, if both placed
    if (shot.blocking.chars.length >= 2) {
      const [a, b] = shot.blocking.chars;
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", a.x * SIZE); line.setAttribute("y1", a.y * SIZE);
      line.setAttribute("x2", b.x * SIZE); line.setAttribute("y2", b.y * SIZE);
      line.setAttribute("stroke", "#3a3040"); line.setAttribute("stroke-width", "1.5"); line.setAttribute("stroke-dasharray", "4 3");
      svg.append(line);
    }
    shot.blocking.chars.forEach((c) => {
      const g = document.createElementNS(svgNS, "g");
      const dot = document.createElementNS(svgNS, "circle");
      dot.setAttribute("cx", c.x * SIZE); dot.setAttribute("cy", c.y * SIZE); dot.setAttribute("r", 9);
      dot.setAttribute("fill", active.kind === "char" && active.key === c.key ? "#c04357" : "#8E2A3C");
      g.append(dot);
      const label = document.createElementNS(svgNS, "text");
      label.setAttribute("x", c.x * SIZE); label.setAttribute("y", c.y * SIZE - 13);
      label.setAttribute("fill", "#cfd6e2"); label.setAttribute("font-size", "9"); label.setAttribute("text-anchor", "middle");
      label.textContent = c.name;
      g.append(label);
      svg.append(g);
    });
    if (shot.blocking.camera) {
      const cam = shot.blocking.camera;
      const tri = document.createElementNS(svgNS, "polygon");
      const x = cam.x * SIZE, y = cam.y * SIZE;
      tri.setAttribute("points", `${x},${y - 8} ${x - 7},${y + 7} ${x + 7},${y + 7}`);
      tri.setAttribute("fill", active.kind === "camera" ? "#5aa9d6" : "#3a80a8");
      svg.append(tri);
      const label = document.createElementNS(svgNS, "text");
      label.setAttribute("x", x); label.setAttribute("y", y + 20);
      label.setAttribute("fill", "#7f8b9e"); label.setAttribute("font-size", "9"); label.setAttribute("text-anchor", "middle");
      label.textContent = "camera";
      svg.append(label);
    }
  }

  svg.onclick = (ev) => {
    const rect = svg.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
    if (active.kind === "camera") {
      shot.blocking.camera = { x, y };
    } else {
      const c = shot.blocking.chars.find((x2) => x2.key === active.key);
      if (c) { c.x = x; c.y = y; }
    }
    redraw();
    persist();
  };

  const rebuildChips = () => {
    chipRow.innerHTML = "";
    shot.blocking.chars.forEach((c) => {
      chipRow.append(mkChip(c.name, active.kind === "char" && active.key === c.key, () => { active = { kind: "char", key: c.key }; redraw(); rebuildChips(); }));
    });
    chipRow.append(mkChip("📷 camera", active.kind === "camera", () => { active = { kind: "camera" }; redraw(); rebuildChips(); }));
    const clear = el("button", null, "Clear");
    clear.style.marginLeft = "auto";
    clear.onclick = () => { shot.blocking.camera = null; redraw(); persist(); };
    chipRow.append(clear);
  };

  rebuildChips();
  redraw();
  box.append(chipRow);
  box.append(svg);
  if (!charAssets.length) {
    box.append(Object.assign(el("div", "mini"), { textContent: "No character references on this shot — add one above to seed a token.", style: "margin-top:6px" }));
  }
  return box;
}

// Per-shot model/duration + live quote, remembered per shot for the session.
const VIDEO_GEN_SEL = new Map(); // shotId -> { modelId, seconds }

// Video generation, right where the shot's own prompts and board still live —
// same fan-out machinery as the Production panel (quote, budget cap,
// confirm-above-threshold), scoped to just this one shot. Takes already on
// the shot are shown with the exact same hover/click thumbnail and Select/
// Delete controls as the Version tray (versionRow itself, reused, not
// reimplemented) so there's one behavior to learn, not two.
// "Add a clip you already have" — a collaborator's render, a clip from another
// machine, an older cut. Free, no gate; lands in the shot's takes (and the
// Version tray) like a generated one, marked as imported.
function importClipPane(shot) {
  const wrap = el("div"); wrap.style.cssText = "padding-bottom:10px;margin-bottom:6px;border-bottom:1px dashed var(--line)";
  wrap.append(Object.assign(el("div"), { textContent: "Add a clip you already have", style: "font-size:12px;font-weight:600;margin-bottom:4px" }));
  const row = el("div", "row"); row.style.gap = "6px";
  const note = Object.assign(document.createElement("input"), { placeholder: "Note — where it's from (e.g. \"from Matías\", \"laptop render\")" });
  note.style.cssText = "flex:1;min-width:200px";
  const fromProject = el("button", null, "From the project…");
  fromProject.title = "Pick a clip that's already somewhere in this series' folder (e.g. AI Source Clips)";
  const fromComputer = el("button", null, "From my computer…");
  fromComputer.title = "Choose a video file from anywhere on this Mac (up to 1 GB)";
  row.append(note, fromProject, fromComputer);
  wrap.append(row);
  const host = el("div"); host.style.marginTop = "6px"; wrap.append(host);
  const status = (t) => { host.innerHTML = ""; if (t) host.append(Object.assign(el("div", "mini"), { textContent: t })); };
  const done = async (v) => {
    status(`Added "${v.modelLabel}" (${v.seconds}s) to shot ${shot.sceneNum}${shot.shotCode}'s takes.`);
    EP = await api(`/api/episode?dir=${encodeURIComponent(EP.dir)}`);
    flashNote(`Clip added to shot ${shot.sceneNum}${shot.shotCode}. Undo removes it.`);
    renderEpisode();
  };

  fromProject.onclick = async () => {
    if (host.querySelector(".assets")) { status(""); return; }
    status("Loading clips…");
    try {
      const q = `dir=${encodeURIComponent(EP.dir)}${SERIES_DIR ? `&seriesDir=${encodeURIComponent(SERIES_DIR)}` : ""}&kind=video`;
      const { files } = await api(`/api/episode/earlier-media?${q}`);
      host.innerHTML = "";
      host.append(earlierPicker(files, shot, { desc: "" }, async (f) => {
        status(`Copying ${f.name} into this episode…`);
        try { await done(await post("/api/episode/take/import", { dir: EP.dir, shotId: shot.id, source: f.path, label: note.value.trim() || f.name })); }
        catch (e) { status(""); fail(e); }
      }, "No video clips found in this series folder."));
    } catch (e) { status(""); fail(e); }
  };

  fromComputer.onclick = () => {
    const fi = Object.assign(document.createElement("input"), { type: "file", accept: "video/*,.mp4,.mov,.m4v,.webm" });
    fi.onchange = async () => {
      const file = fi.files && fi.files[0]; if (!file) return;
      status(`Uploading ${file.name} (${(file.size / 1048576).toFixed(1)} MB)…`);
      try {
        const qs = new URLSearchParams({ dir: EP.dir, shotId: shot.id, filename: file.name, label: note.value.trim() || file.name });
        const res = await fetch(`/api/episode/take/upload?${qs}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `upload failed (${res.status})`);
        scheduleUndoRefresh();
        await done(data);
      } catch (e) { status(""); fail(e); }
    };
    fi.click();
  };
  return wrap;
}

// Dialogue audio — recorded lines (ElevenLabs downloads, a collaborator's
// session) attached to this shot. Free, no gate. A clip does nothing on its
// own: it's what a take's "Lip sync…" button in the Version tray reads.
function dialogueAudioPane(shot) {
  const wrap = el("div"); wrap.style.cssText = "padding-bottom:10px;margin-bottom:6px;border-bottom:1px dashed var(--line)";
  wrap.append(Object.assign(el("div"), { textContent: "Dialogue audio (used by Lip sync on a take)", style: "font-size:12px;font-weight:600;margin-bottom:4px" }));

  (shot.audioClips || []).forEach((c) => {
    const row = el("div", "row"); row.style.cssText = "gap:8px;margin-bottom:4px;align-items:center";
    const au = Object.assign(document.createElement("audio"), { controls: true, preload: "none", src: mediaURL(c.path) });
    au.style.cssText = "height:28px;max-width:240px";
    row.append(au, Object.assign(el("span", "mini"), { textContent: `${c.label} · ${c.seconds}s`, style: "flex:1" }));
    const del = el("button", null, "✕");
    del.title = "Remove this audio clip from the shot (the file stays on disk; Undo brings the record back).";
    del.onclick = async () => {
      if (!confirm(`Remove "${c.label}" from this shot?\n\nThe file stays on disk. Lip-sync takes already made from it are unaffected.`)) return;
      try { await post("/api/episode/audio/delete", { dir: EP.dir, shotId: shot.id, audioClipId: c.id }); await reloadEpisode(shot.id); } catch (e) { fail(e); }
    };
    row.append(del);
    wrap.append(row);
  });

  const row = el("div", "row"); row.style.gap = "6px";
  const note = Object.assign(document.createElement("input"), { placeholder: "Label — who says it (e.g. \"Overlock: 'They're coming'\")" });
  note.style.cssText = "flex:1;min-width:200px";
  const fromProject = el("button", null, "From the project…");
  fromProject.title = "Pick an audio file that's already somewhere in this series' folder";
  const fromComputer = el("button", null, "From my computer…");
  fromComputer.title = "Choose a .wav / .mp3 / .m4a file from anywhere on this Mac";
  row.append(note, fromProject, fromComputer);
  wrap.append(row);
  const host = el("div"); host.style.marginTop = "6px"; wrap.append(host);
  const status = (t) => { host.innerHTML = ""; if (t) host.append(Object.assign(el("div", "mini"), { textContent: t })); };
  const done = async (c) => { flashNote(`Audio added to shot ${shot.sceneNum}${shot.shotCode}. Undo removes it.`); await reloadEpisode(shot.id); return c; };

  fromProject.onclick = async () => {
    if (host.querySelector(".audlist")) { status(""); return; }
    status("Loading audio…");
    try {
      const q = `dir=${encodeURIComponent(EP.dir)}${SERIES_DIR ? `&seriesDir=${encodeURIComponent(SERIES_DIR)}` : ""}&kind=audio`;
      const { files } = await api(`/api/episode/earlier-media?${q}`);
      host.innerHTML = "";
      if (!files.length) { status("No audio files found in this series folder."); return; }
      const list = el("div", "audlist"); list.style.cssText = "display:flex;flex-direction:column;gap:3px;max-height:220px;overflow:auto";
      files.forEach((f) => {
        const b = el("button", null, `${f.name}  ·  ${f.folder}`); b.style.cssText = "text-align:left;font-size:11px;padding:3px 8px";
        b.onclick = async () => {
          status(`Copying ${f.name} into this episode…`);
          try { await post("/api/episode/audio/import", { dir: EP.dir, shotId: shot.id, source: f.path, label: note.value.trim() || f.name }); await done(); }
          catch (e) { status(""); fail(e); }
        };
        list.append(b);
      });
      host.append(list);
    } catch (e) { status(""); fail(e); }
  };

  fromComputer.onclick = () => {
    const fi = Object.assign(document.createElement("input"), { type: "file", accept: "audio/*,.wav,.mp3,.m4a,.aac,.ogg" });
    fi.onchange = async () => {
      const file = fi.files && fi.files[0]; if (!file) return;
      status(`Uploading ${file.name} (${(file.size / 1048576).toFixed(1)} MB)…`);
      try {
        const qs = new URLSearchParams({ dir: EP.dir, shotId: shot.id, filename: file.name, label: note.value.trim() || file.name });
        const res = await fetch(`/api/episode/audio/upload?${qs}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `upload failed (${res.status})`);
        scheduleUndoRefresh();
        await done(data);
      } catch (e) { status(""); fail(e); }
    };
    fi.click();
  };
  return wrap;
}

// ---------- video model picker: Model → Mode → Tier → Quality → Via ----------
// Shawn, 2026-10-12: short rows of chips instead of one long list. Every
// combination is still one model row on the server (rates.js), so the pick
// is a model id; rows only appear when there's a real choice to make.
const PICK_FAMILIES = [["h3max", "MiniMax H3 Max"], ["h3", "MiniMax H3"], ["sd25", "Seedance 2.5"], ["sd20", "Seedance 2.0"], ["kling3", "Kling v3"], ["wan3", "Wan 3.0"]];
const PICK_RES_ORDER = ["480p draft", "480p", "480P", "720p", "768P", "1080p", "1080P", "2K", "4k", "4K"];
const pickMoney = (m) => `$${Number(m.usdPerVideoSecond).toFixed(m.usdPerVideoSecond < 0.1 ? 3 : 2)}`;
const pickEst = (m) => (m.confidence === "exact" || m.confidence === "measured" || m.confidence === "live" ? "" : "~");
// Shawn, 2026-10-17: Atlas is cheaper than fal on everything it sells except
// MiniMax H3 Max, so a pick should land on the cheapest CONNECTED service that
// sells that exact combination (the same rule the server's cheapest route
// applies when a take is sent), not on fal by default.
function viaReady(via) { const d = MODELS && MODELS.drivers && MODELS.drivers[via || "fal"]; return !d || d.ready; }
function cheapestSibling(m) {
  if (CHEAPEST_ROUTE === false || !(MODELS && MODELS.video)) return m;
  const same = MODELS.video.filter((x) => x.family === m.family && x.mode === m.mode && (x.tier || null) === (m.tier || null) && (x.res || null) === (m.res || null) && !x.optIn);
  const ready = same.filter((x) => viaReady(x.via));
  if (!ready.length) return m;
  const best = ready.reduce((a, x) => (x.usdPerVideoSecond < a.usdPerVideoSecond ? x : a), ready[0]);
  return viaReady(m.via) && best.usdPerVideoSecond >= m.usdPerVideoSecond * 0.995 ? m : best;
}
function pickBest(models, want) {
  // Exact match first; otherwise keep what matters most: family, mode, tier, quality, service.
  const score = (m) => (m.family === want.family ? 1000 : 0) + (m.mode === want.mode ? 100 : 0) + ((m.tier || null) === (want.tier || null) ? 30 : 0) + ((m.res || null) === (want.res || null) ? 10 : 0) + ((m.via || "fal") === (want.via || "fal") ? 3 : 0) + (m.id.includes("@") ? 0 : 1);
  return cheapestSibling([...models].sort((a, b) => score(b) - score(a))[0]);
}
// Cheapest route (2026-10-13): the server may send a take through another
// connected service that sells the same model for less. The quote says so.
let CHEAPEST_ROUTE = null; // null until /api/settings answers; the server default is on
function loadRouteSetting() { if (CHEAPEST_ROUTE == null) api("/api/settings").then((s) => { CHEAPEST_ROUTE = s.cheapestRoute !== false; }).catch(() => {}); }
const VIA_NAMES = { atlas: "Atlas", comfy: "Comfy", sume: "Sume" };
const viaName = (id) => { const m = MODELS && MODELS.video && MODELS.video.find((x) => x.id === id); const v = (m && m.via) || "fal"; return VIA_NAMES[v] || v; };
function routeNote(q) {
  const moved = (q.lines || []).filter((l) => l.routedFrom);
  if (!moved.length) return null;
  const l = moved[0];
  const text = moved.length === 1 && q.lines.length === 1
    ? `Cheapest route: sent via ${viaName(l.modelId)} at $${l.rate.toFixed(3)}/s instead of ${viaName(l.routedFrom)} at $${l.pickedRate.toFixed(3)}/s (saves ~$${q.routedSavingUSD.toFixed(2)}).`
    : `Cheapest route: ${moved.length} of ${q.lines.length} clips go through a cheaper connected service (saves ~$${q.routedSavingUSD.toFixed(2)}).`;
  return Object.assign(el("div", "mini"), { textContent: text, title: "Same model, another aggregator you've connected. Turn this off in the VIA row of the model picker.", style: "margin-top:2px" });
}
function videoModelPicker(models, curId, onPick) {
  loadRouteSetting();
  const cur = models.find((m) => m.id === curId) || models[0];
  const box = el("div", "rc-vpick");
  const ready = (via) => { const d = MODELS && MODELS.drivers && MODELS.drivers[via]; return !d || d.ready; };
  const rowOf = (label, chips) => { const r = el("div", "row"); r.append(el("span", "k", label)); chips.forEach((c) => r.append(c)); box.append(r); };
  const chip = (text, on, target, title) => {
    const b = el("button", "rc-chip" + (on ? " on" : "") + (target && !ready(target.via || "fal") ? " off" : ""), text);
    if (title) b.title = title;
    b.onclick = () => { if (target && target.id !== cur.id) onPick(target.id); };
    return b;
  };
  // Model
  const fams = PICK_FAMILIES.filter(([id]) => models.some((m) => m.family === id));
  const fsel = document.createElement("select");
  fams.forEach(([id, label]) => fsel.append(Object.assign(document.createElement("option"), { value: id, textContent: label, selected: id === cur.family })));
  fsel.onchange = () => {
    const inFam = models.filter((m) => m.family === fsel.value);
    const pick = inFam.find((m) => !m.id.includes("@") && (m.via || "fal") === "fal" && m.mode === "frames") || inFam[0];
    onPick(cheapestSibling(pick).id);
  };
  const r0 = el("div", "row"); r0.append(el("span", "k", "MODEL"), fsel); box.append(r0);
  const fam = models.filter((m) => m.family === cur.family);
  // Mode
  const modes = [...new Set(fam.map((m) => m.mode))];
  if (modes.length > 1) rowOf("MODE", modes.map((md) => chip(md === "refs" ? "References" : "Frames", md === cur.mode, pickBest(fam.filter((m) => m.mode === md), cur), md === "refs" ? "Many images (and reference video) addressed in the prompt" : "Start + end storyboard frames")));
  const inMode = fam.filter((m) => m.mode === cur.mode);
  // Tier
  const tiers = [...new Set(inMode.map((m) => m.tier).filter(Boolean))];
  if (tiers.length > 1) rowOf("TIER", ["standard", "fast", "mini"].filter((t) => tiers.includes(t)).map((t) => chip(t[0].toUpperCase() + t.slice(1), t === cur.tier, pickBest(inMode.filter((m) => m.tier === t), cur))));
  const inTier = inMode.filter((m) => (m.tier || null) === (cur.tier || null));
  // Quality, priced on the current service where it sells it
  const resList = [...new Set(inTier.map((m) => m.res).filter(Boolean))].sort((a, b) => PICK_RES_ORDER.indexOf(a) - PICK_RES_ORDER.indexOf(b));
  if (resList.length) rowOf("QUALITY", resList.map((r) => {
    const opts = inTier.filter((m) => m.res === r);
    const t = opts.find((m) => (m.via || "fal") === (cur.via || "fal")) || opts[0];
    return chip(`${r} ${pickEst(t)}${pickMoney(t)}`, r === cur.res, t, `${t.label} · ${pickMoney(t)} per second${pickEst(t) ? " (estimate)" : ""}`);
  }));
  // Via: only when more than one service sells this exact combination
  const vias = inTier.filter((m) => m.res === cur.res);
  if (vias.length > 1) {
    const auto = el("button", "rc-chip" + (CHEAPEST_ROUTE !== false ? " on" : ""), "CHEAPEST");
    auto.title = "On: each take goes through whichever connected service sells this exact model for less right now (live prices where the price watch has them). Off: always the service picked here.";
    auto.onclick = async () => {
      try {
        const r = await post("/api/settings/cheapest-route", { on: CHEAPEST_ROUTE === false });
        CHEAPEST_ROUTE = r.cheapestRoute; onPick(cur.id);
      } catch (e) { fail(e); }
    };
    rowOf("VIA", [auto, ...vias.map((m) => chip(`${VIA_NAMES[m.via || "fal"] || "fal"} ${pickEst(m)}${pickMoney(m)}`, m.id === cur.id, m, ready(m.via || "fal") ? "" : `Connect ${VIA_NAMES[m.via] || m.via} in Connections first`))]);
  }
  if (!ready(cur.via || "fal")) box.append(el("div", "rc-muted warn", `${{ atlas: "Atlas Cloud", comfy: "Comfy", sume: "Sume" }[cur.via] || cur.via} isn't connected — add its key in Connections (⚙︎) before generating.`));
  return box;
}

// The length a shot's Generate pane opens on: the remaster target from the
// cut, else the length last picked for the shot, else its storyboard timing.
function shotStartSeconds(shot) {
  const beatSec = (shot.beats || []).reduce((t, b) => t + (Number(b.durationSec) || 0), 0);
  return (shot.remaster && shot.remaster.targetSeconds) || Number(shot.videoSeconds) || (beatSec > 0 ? beatSec : null);
}

function videoGeneratePane(shot) {
  const box = el("div", "card"); box.style.cssText = "margin-top:10px;background:var(--panel2)";
  box.append(Object.assign(el("h3"), { textContent: "Generate video", style: "font-size:12px;margin-bottom:6px" }));

  box.append(fold("g-clip", "ADD A CLIP YOU ALREADY HAVE", "from the project or your computer", (b) => b.append(importClipPane(shot))));
  const nAudio = (shot.audioClips || []).length;
  box.append(fold("g-dlg", "DIALOGUE AUDIO", nAudio ? `${nAudio} recording${nAudio === 1 ? "" : "s"}` : "none yet", (b) => b.append(dialogueAudioPane(shot))));

  // The shot's takes show whatever blocks generation (they used to be on the
  // always-visible Version tray; now this is the only place per shot).
  const takesList = () => {
    const takesHost = el("div"); takesHost.style.marginTop = "10px";
    const head = el("div", "row"); head.style.cssText = "align-items:center;gap:8px";
    head.append(Object.assign(el("div", "mini"), { textContent: "Takes for this shot:" }));
    const failed = (shot.versions || []).filter((v) => v.state === "error" || v.state === "cancelled");
    if (failed.length) {
      const clr = el("button", null, `Clear ${failed.length} failed`);
      clr.style.cssText = "font-size:11px;padding:2px 8px";
      clr.title = "Remove every failed take of this shot from the list (they never produced a video)";
      clr.onclick = async () => {
        try { for (const f of failed) await post("/api/episode/version/delete", { dir: EP.dir, versionId: f.id }); await reloadEpisode(shot.id); } catch (e) { fail(e); }
      };
      head.append(clr);
    }
    takesHost.append(head);
    shot.versions.forEach((v) => takesHost.append(versionRow({
      ...v, shotId: v.shotId || shot.id, shotCode: `${shot.sceneNum}${shot.shotCode}`, shotLabel: shot.label,
      selected: (shot.selectedVersions || []).includes(v.id),
      trackIndex: (shot.selectedVersions || []).indexOf(v.id),
    })));
    const n = shot.versions.length, nSel = (shot.selectedVersions || []).length, nFail = (shot.versions || []).filter((v) => v.state === "error").length;
    return fold("g-takes", "TAKES FOR THIS SHOT", `${n} take${n === 1 ? "" : "s"}${nSel ? ` · ${nSel} selected` : ""}${nFail ? ` · ${nFail} failed` : ""}`, (b) => b.append(takesHost), true);
  };
  const hasApprovedFrame = (shot.beats || []).some((b) => b.keyframe && b.frame && b.frame.approved);
  if (!hasApprovedFrame) {
    box.append(Object.assign(el("div", "mini"), { textContent: "Generating a new clip needs an approved storyboard for this shot first (gate G3 — it stops paid generation before boards are signed off). Adding a clip you already have, above, doesn't.", style: "margin-top:10px" }));
    if ((shot.versions || []).length) box.append(takesList());
    return box;
  }
  if (!(shot.move && shot.move.trim())) {
    box.append(Object.assign(el("div", "mini warn"), { textContent: "No camera move chosen for this shot (Move, above) — pick one before generating. Adding a clip you already have, above, doesn't need this.", style: "margin-top:10px" }));
    if ((shot.versions || []).length) box.append(takesList());
    return box;
  }

  function draw() {
    box.querySelectorAll(".vgp-body").forEach((n) => n.remove());
    const bodyEl = el("div"); bodyEl.className = "vgp-body";
    const pp = (PROMPTS.shots || []).find((x) => x.id === shot.id) || {};
    const videoModels = (MODELS && MODELS.video) || [];
    const curModel = videoModels.find((m) => m.id === (VIDEO_GEN_SEL.get(shot.id) || {}).modelId);
    if (!(curModel && (curModel.inputMode === "reference" || curModel.inputMode === "frames+refs"))) {
      bodyEl.append(Object.assign(el("div", "mini"), {
        textContent: `Sends this shot's ${pp.videoMode === "timecoded" ? "Timecoded" : "Shot direction"} prompt (Video prompt, above).`,
        style: "margin:2px 0 6px",
      }));
    }
    if (!videoModels.length) {
      bodyEl.append(Object.assign(el("div", "mini"), { textContent: "Loading models…" }));
      box.append(bodyEl);
      return;
    }

    // A remaster shot starts at the sellable length NEAREST its target from
    // the cut (cut span + handles) — not rounded up: models stretch the
    // action to fill the length (Shawn, 2026-10-09).
    // Otherwise: the length last picked for this shot (saved on the shot, so a
    // reload or restart keeps it), else the shot's storyboard timing. Starting
    // on the model's shortest length sent an 11 s shot as 4 s (1y, 2026-10-20).
    // `target` stays remaster-only: the "Target from the cut" note below reads
    // shot.remaster. `startSec` is what a fresh pane opens on.
    const target = shot.remaster && shot.remaster.targetSeconds;
    const startSec = shotStartSeconds(shot);
    const fitTarget = (m) => {
      const ds = [...(m.durations || [5])].sort((a, b) => a - b);
      return startSec ? nearestSellable(ds, startSec) : ds[0];
    };
    let sel = VIDEO_GEN_SEL.get(shot.id);
    if (!sel || !videoModels.find((m) => m.id === sel.modelId)) {
      // Starts on the shot's last pick, else the episode default (saved, so it
      // survives a reload — an in-memory pick once reset to H3 on every reload).
      const m0 = videoModels.find((m) => m.id === videoModelFor(shot, EP, videoModels.map((x) => x.id)));
      sel = { modelId: m0.id, seconds: fitTarget(m0) };
      VIDEO_GEN_SEL.set(shot.id, sel);
    }
    const model = videoModels.find((m) => m.id === sel.modelId);

    const ctlRow = el("div", "grid g2");
    const modelBody = el("div"), refBody = el("div");
    let refTitle = "REFERENCES", refSummary = "";
    const pickModel = (id) => {
      sel.modelId = id;
      const m2 = videoModels.find((x) => x.id === sel.modelId);
      if (m2 && startSec) sel.seconds = fitTarget(m2);
      else if (m2 && m2.durations && !m2.durations.includes(sel.seconds)) sel.seconds = m2.durations[0];
      // Remember the pick on the shot; picking the episode default clears it,
      // so a later change of default still reaches this shot.
      const keep = sel.modelId === EP.defaultVideoModelId ? "" : sel.modelId;
      shot.videoModelId = keep;
      draw();
      // The Video prompt box above follows the model (H3 Max gets fal's
      // brief shape), so fetch the prompts again once the pick is saved.
      post("/api/episode/video-model", { dir: EP.dir, shotId: shot.id, modelId: keep })
        .then(() => refreshPrompts(shot.id)).catch(fail);
    };
    modelBody.append(videoModelPicker(videoModels, sel.modelId, pickModel));

    const secSel = document.createElement("select");
    (model.durations || [5, 10]).forEach((n) => {
      const o = document.createElement("option"); o.value = n; o.textContent = `${n}s`;
      if (sel.seconds === n) o.selected = true;
      secSel.append(o);
    });
    secSel.onchange = () => {
      sel.seconds = Number(secSel.value);
      shot.videoSeconds = sel.seconds;
      draw();
      post("/api/episode/shot/update", { dir: EP.dir, shotId: shot.id, patch: { videoSeconds: sel.seconds } }).catch(fail);
    };
    ctlRow.append(labeled("Duration", secSel));
    modelBody.append(ctlRow);
    // Models with a sound switch (Atlas Seedance): same price either way. Off
    // when the generated sound warbles; the take then has no audio track.
    if (model.audioSwitch) {
      // Two chips like the other pickers, so it reads as a choice: On (the
      // model makes effects, ambience and speech) or Off (a silent take).
      // Same price either way. (Shawn, 2026-10-17: a bare checkbox did not say
      // which way it switched.)
      const sb = el("div", "rc-vpick");
      const row = el("div", "row"); row.append(el("span", "k", "SOUND"));
      const sChip = (text, on, val, title) => {
        const b = el("button", "rc-chip" + (on ? " on" : ""), text);
        b.title = title;
        b.onclick = () => { sel.audio = val; draw(); };
        return b;
      };
      row.append(
        sChip("On", sel.audio !== false, true, "The model generates sound: effects, ambience and speech"),
        sChip("Off", sel.audio === false, false, "A silent take. Same price. Use it when the sound warbles, or when you will add the sound yourself"),
      );
      sb.append(row);
      sb.append(Object.assign(el("div", "mini"), {
        textContent: sel.audio === false
          ? "Silent take: no sound from the model. Add voices and sound in Post-production → Sound. Same price."
          : "The model makes the sound: effects, ambience and any speech. Same price if you turn it off.",
        style: "margin:2px 0 4px",
      }));
      modelBody.append(sb);
    }
    if (target) {
      const r = shot.remaster;
      modelBody.append(Object.assign(el("div", "mini"), {
        textContent: `Target from the cut: ${r.spanSec.toFixed(2)} s used + ${r.handlesSec} s handles each end = ${target.toFixed(2)} s.${sel.seconds < target ? ` ${model.label} sells nothing that long — ${sel.seconds} s is its longest.` : ""}`,
        style: "margin:2px 0 6px",
      }));
    }

    const approvedKf = (shot.beats || []).filter((b) => b.keyframe && b.frame && b.frame.approved).length;
    const modelSlots = (model.imageParams || []).length || 1;
    if (model.inputMode === "reference") {
      // Reference mode: show EXACTLY what will be uploaded and sent — the
      // same resolver the job queue freezes onto the take.
      const ref = resolveReferencePrompt(shot, EP, { videos: model.refVideo ? refVideoSet(shot, model.refVideo).videos : [], max: model.maxRefs });
      const wrap = el("div"); wrap.style.cssText = "margin:4px 0 8px;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--panel)";
      wrap.append(Object.assign(el("div"), { textContent: `Sends ${ref.images.length} reference image${ref.images.length === 1 ? "" : "s"}${ref.videos.length ? ` + ${ref.videos.length} reference video${ref.videos.length === 1 ? "" : "s"}` : ""} — not just a start and end frame`, style: "font-size:12px;font-weight:600;margin-bottom:6px" }));
      const strip = el("div"); strip.style.cssText = "display:flex;flex-wrap:wrap;gap:8px";
      ref.images.forEach((x) => {
        const cell = el("div"); cell.style.cssText = "width:84px;font-size:10px";
        const t = imageThumb(x.path, () => {}, { width: "84px", height: "84px" });
        t.title = x.label;
        cell.append(t, Object.assign(el("div", "mini"), { textContent: `${x.ref} · ${x.kind === "storyboard" ? "storyboard" : x.label.replace(/ \(.*/, "")}`, style: "margin-top:2px;word-break:break-word" }));
        strip.append(cell);
      });
      wrap.append(strip);
      if (ref.dropped) wrap.append(Object.assign(el("div", "mini warn"), { textContent: `${ref.dropped} more image${ref.dropped === 1 ? "" : "s"} over the ${model.maxRefs || 12}-image limit were left out (storyboards win over assets).`, style: "margin-top:6px" }));
      wrap.append(Object.assign(el("div", "mini"), { textContent: "Assets without an image file are skipped. Approve a storyboard or attach a file in the Identity Vault to change the set.", style: "margin-top:6px" }));
      const det = el("details"); det.style.marginTop = "6px";
      det.append(Object.assign(el("summary"), { textContent: "The exact prompt that will be sent", style: "cursor:pointer;font-size:11px" }));
      det.append(Object.assign(el("pre"), { textContent: ref.text, style: "white-space:pre-wrap;font-size:11px;margin:6px 0 0;max-height:260px;overflow:auto" }));
      wrap.append(det);
      wrap.append(Object.assign(el("div", "mini warn"), { textContent: "fal notes Seedance 2.5 rejects many human-face image inputs. A rejected take shows an error here; a rejection at submit is not charged by this app.", style: "margin-top:6px" }));
      refBody.append(wrap);
      refTitle = "REFERENCE IMAGES"; refSummary = `${ref.images.length} image${ref.images.length === 1 ? "" : "s"}${ref.videos.length ? ` + ${ref.videos.length} video${ref.videos.length === 1 ? "" : "s"}` : ""} · ${ref.images.filter((x) => x.kind === "storyboard").length} storyboard${ref.images.filter((x) => x.kind === "storyboard").length === 1 ? "" : "s"}, ${ref.images.filter((x) => x.kind !== "storyboard").length} from the vault`;
    } else if (modelSlots > 1 && approvedKf >= 2) {
      // Pick start and end right here (Shawn, 2026-10-08: on 5a the wrong
      // end frame went out, and the only control was a button inside a
      // collapsed row of the Storyboard panel, where three storyboards with
      // the same description were hard to tell apart). Thumbnails come from
      // resolveStartEndBeats — the same resolver Generate uses.
      const { start, end } = resolveStartEndBeats(shot);
      const kf = (shot.beats || []).filter((b) => b.keyframe);
      const wrap = el("div"); wrap.style.cssText = "margin:4px 0 8px;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--panel)";
      wrap.append(Object.assign(el("div"), {
        textContent: `Frames sent: start and end${shot.startBeatId || shot.endBeatId ? "" : " (automatic: first and last approved — pick to change)"}`,
        style: "font-size:12px;font-weight:600;margin-bottom:6px",
      }));
      const strip = el("div"); strip.style.cssText = "display:flex;flex-wrap:wrap;gap:10px";
      const setPick = (key, val) => post("/api/episode/shot/update", { dir: EP.dir, shotId: shot.id, patch: { [key]: val } }).then(() => reloadEpisode(shot.id)).catch(fail);
      kf.forEach((b, i) => {
        if (!(b.frame && b.frame.approved && b.frame.path)) return;
        const isS = start && start.id === b.id, isE = end && end.id === b.id;
        const cell = el("div"); cell.style.cssText = `width:96px;font-size:10px;padding:3px;border-radius:6px;border:2px solid ${isS || isE ? "var(--accent, #c0392b)" : "transparent"}`;
        const t = imageThumb(b.frame.path, () => {}, { width: "96px", height: "96px" });
        t.title = b.frame.path.split("/").pop();
        const cap = Object.assign(el("div", "mini"), { textContent: `storyboard ${i + 1} · ${b.role}${isS ? " — START" : ""}${isE ? " — END" : ""}`, style: "margin:3px 0;word-break:break-word" });
        const bs = el("button", isS ? "primary" : null, isS ? "✓ Start" : "Start");
        const be = el("button", isE ? "primary" : null, isE ? "✓ End" : "End");
        [bs, be].forEach((x) => { x.style.cssText = "font-size:10px;padding:2px 6px"; });
        // One storyboard can't be both: the resolver would drop the end.
        bs.disabled = isS || isE; be.disabled = isE || isS;
        bs.title = isE ? "This is the end frame — pick another end first" : "Send this storyboard as the start frame";
        be.title = isS ? "This is the start frame — pick another start first" : "Send this storyboard as the end frame";
        bs.onclick = () => setPick("startBeatId", b.id);
        be.onclick = () => setPick("endBeatId", b.id);
        const btns = el("div"); btns.style.cssText = "display:flex;gap:4px";
        btns.append(bs, be);
        cell.append(t, cap, btns);
        strip.append(cell);
      });
      wrap.append(strip);
      if (shot.startBeatId || shot.endBeatId) {
        const auto = el("button", null, "Back to automatic");
        auto.style.cssText = "font-size:10px;padding:2px 8px;margin-top:6px";
        auto.title = "Clear both picks: first approved storyboard as start, last as end";
        auto.onclick = () => post("/api/episode/shot/update", { dir: EP.dir, shotId: shot.id, patch: { startBeatId: null, endBeatId: null } }).then(() => reloadEpisode(shot.id)).catch(fail);
        wrap.append(auto);
      }
      if (approvedKf > modelSlots) wrap.append(Object.assign(el("div", "mini"), { textContent: `${model.label} takes ${modelSlots} frames; the other ${approvedKf - modelSlots} approved storyboard${approvedKf - modelSlots === 1 ? " stays" : "s stay"} on the board for comparison.`, style: "margin-top:6px" }));
      refBody.append(wrap);
      refTitle = "FRAMES SENT"; refSummary = shot.startBeatId || shot.endBeatId ? "start and end picked by you" : "start and end: automatic";
    }

    refBody.append(shotRefsSection(shot, "gen"));
    if (model.inputMode === "frames+refs") {
      // H3 Max references: what goes as Image 1…, from the SAME resolver the
      // job queue freezes onto the take (shown == sent).
      const fr = resolveFramesRefPrompt(shot, EP, { max: model.maxRefs || 9, videos: model.refVideo ? refVideoSet(shot, model.refVideo).videos : [] });
      const wrap = el("div"); wrap.style.cssText = "margin:4px 0 8px;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--panel)";
      wrap.append(Object.assign(el("div"), { textContent: `Identity references sent: ${fr.images.length} image${fr.images.length === 1 ? "" : "s"}${fr.videos.length ? ` + ${fr.videos.length} reference video${fr.videos.length === 1 ? "" : "s"}` : ""} (plus the start/end frames above)`, style: "font-size:12px;font-weight:600;margin-bottom:6px" }));
      if (!fr.images.length) {
        wrap.append(Object.assign(el("div", "mini warn"), { textContent: "No Identity Vault references on this shot yet. Attach the characters (and the location) to the shot to lock faces and wardrobe; every angle of a character is sent, turnaround and face close-ups." }));
      } else {
        const strip = el("div"); strip.style.cssText = "display:flex;flex-wrap:wrap;gap:8px";
        fr.images.forEach((x) => {
          const cell = el("div"); cell.style.cssText = "width:96px;font-size:10px";
          const t = imageThumb(x.path, () => {}, { width: "96px", height: "72px" });
          t.title = x.label;
          cell.append(t, Object.assign(el("div", "mini"), { textContent: `${x.ref} · ${x.label}`, style: "margin-top:2px;word-break:break-word" }));
          strip.append(cell);
        });
        wrap.append(strip);
        if (fr.dropped) wrap.append(Object.assign(el("div", "mini warn"), { textContent: `${fr.dropped} more image${fr.dropped === 1 ? "" : "s"} over the ${model.maxRefs || 9}-image limit were left out.`, style: "margin-top:6px" }));
        wrap.append(Object.assign(el("div", "mini"), { textContent: "Wide sheets are padded with black to fit H3's 2.5:1 limit; nothing is cropped.", style: "margin-top:6px" }));
      }
      const det = el("details"); det.style.marginTop = "6px";
      det.append(Object.assign(el("summary"), { textContent: "The exact prompt that will be sent", style: "cursor:pointer;font-size:11px" }));
      det.append(Object.assign(el("pre"), { textContent: fr.text, style: "white-space:pre-wrap;font-size:11px;margin:6px 0 0;max-height:260px;overflow:auto" }));
      wrap.append(det);
      refBody.append(wrap);
      refTitle = "FRAMES + IDENTITY REFERENCES"; refSummary = `start/end + ${fr.images.length} image${fr.images.length === 1 ? "" : "s"}`;
    }
    // The model / length / sound group, then the references group: each one line when closed.
    const sndTxt = model.audioSwitch ? ` · sound ${sel.audio === false ? "off" : "on"}` : "";
    bodyEl.append(fold("g-model", "MODEL · LENGTH · SOUND", `${model.label} · ${sel.seconds}s${sndTxt}`, (b) => b.append(modelBody), true));
    if (!refSummary) refSummary = `${(shot.refs || []).length} on this shot`;
    bodyEl.append(fold("g-refs", refTitle, refSummary, (b) => b.append(refBody), false));
    if (model.inputMode !== "reference") bodyEl.append(claudePromptTool(shot, sel));

    const quoteHost = el("div"); quoteHost.style.margin = "6px 0";
    quoteHost.append(Object.assign(el("div", "mini"), { textContent: "Pricing…" }));
    bodyEl.append(quoteHost);
    box.append(bodyEl);

    (async () => {
      try {
        const q = await post("/api/episode/quote", { dir: EP.dir, shotIds: [shot.id], modelIds: [sel.modelId], seconds: sel.seconds });
        quoteHost.innerHTML = "";
        const qRow = el("div", "row");
        qRow.append(Object.assign(el("span", "pill" + (q.fitsInBudget ? "" : " warn")), { textContent: `est. $${q.totalUSD.toFixed(2)}` }));
        if (!q.fitsInBudget) qRow.append(Object.assign(el("span", "pill warn"), { textContent: `over budget — $${q.ledger.remainingUSD.toFixed(2)} left` }));
        quoteHost.append(qRow);
        const rn = routeNote(q); if (rn) quoteHost.append(rn);
        if (q.uncalibrated.length) {
          quoteHost.append(Object.assign(el("div", "mini"), { textContent: "Estimate only — this model bills in units its service can't quote before a run.", style: "color:var(--warn);margin-top:2px" }));
        }

        const genBtn = el("button", "primary", `Generate video — $${q.totalUSD.toFixed(2)}`);
        genBtn.disabled = !q.fitsInBudget;
        genBtn.style.marginTop = "6px";
        genBtn.onclick = async () => {
          // A second click on the same model a moment later is nearly always an accident.
          const dup = (shot.versions || []).filter((v) => (v.state === "queued" || v.state === "running") && v.modelId === sel.modelId && !v.op);
          if (dup.length && !confirm(`This shot already has ${dup.length} ${model.label} take${dup.length === 1 ? "" : "s"} queued or running.\n\nQueue another one anyway?`)) return;
          if (q.needsConfirmation) {
            const ok = confirm(`Generate 1 clip on ${q.lines[0] ? q.lines[0].modelLabel : model.label}?\n\nEstimated cost: $${q.totalUSD.toFixed(2)}\nBudget left after: $${(q.ledger.remainingUSD - q.totalUSD).toFixed(2)}\n\nProceed?`);
            if (!ok) return;
          }
          genBtn.disabled = true; genBtn.textContent = "Submitting…";
          try {
            await post("/api/episode/fanout", { dir: EP.dir, shotIds: [shot.id], modelIds: [sel.modelId], seconds: sel.seconds, driver: "fal", confirmedUSD: q.totalUSD, ...(model.audioSwitch && sel.audio === false ? { audio: false } : {}) });
            await reloadEpisode(shot.id);
          } catch (e) {
            genBtn.disabled = false; genBtn.textContent = `Generate video — $${q.totalUSD.toFixed(2)}`;
            fail(e);
          }
        };
        quoteHost.append(genBtn);
      } catch (e) { quoteHost.innerHTML = ""; fail(e); }
    })();

    if ((shot.versions || []).length) bodyEl.append(takesList());
  }

  draw();
  if (!MODELS || !MODELS.video || !MODELS.video.length) {
    api("/api/models").then((m) => { MODELS = m; draw(); }).catch(() => {});
  }
  return box;
}

// Editable: this box's text is either the auto-built prompt (from the
// structured fields above it) or a hand-edited override, and `onChange` is
// what persists an edit — same value shared/prompts.js's resolveNano/
// resolveGpt read back, so an edit here changes what Generate actually sends,
// not just what's shown. `onChange("")` (via Reset) clears the override.
// The ONE video prompt for this shot, in the style chosen here — and exactly
// the text Generate sends (shared/prompts.js resolveVideoPrompt).
function videoPromptSection(shot, p) {
  const wrap = el("div"); wrap.style.marginTop = "10px";
  const head = el("div", "row"); head.style.cssText = "gap:6px;align-items:center;margin-bottom:4px";
  head.append(Object.assign(el("div"), { textContent: "Video prompt", style: "font-weight:600;font-size:13px" }));
  head.append(Object.assign(el("span", "mini"), { textContent: "— what Generate sends. Style:", style: "margin-right:4px" }));
  const mode = p.videoMode || "direction";
  const choose = (m, label, title) => {
    const b = el("button", "pill" + (mode === m ? " on" : ""), label); b.title = title;
    b.onclick = async () => {
      if (mode === m) return;
      try {
        await post("/api/episode/shot/update", { dir: EP.dir, shotId: shot.id, patch: { videoPromptMode: m } });
        shot.videoPromptMode = m;
        await refreshPrompts(shot.id);
      } catch (e) { fail(e); }
    };
    head.append(b);
  };
  choose("direction", "Shot direction", "Plain-language direction: what moves, and how the camera moves. The start frame carries the look.");
  choose("timecoded", "Timecoded", "Beat-by-beat [00:00–00:02] script, with each beat's own framing and camera move.");
  wrap.append(head);
  if (mode === "timecoded") {
    wrap.append(promptBox("Timecoded", "badge-seed", p.timecode || "", p.timecodeIsOverride, shotField(shot, "timecodePrompt")));
    wrap.append(Object.assign(el("div", "mini"), { textContent: "The \"Asset map\" lines are for pasting into Seedance's own omni-reference tool. They're left out of what Generate sends here, because these models get the start frame only.", style: "margin-top:2px" }));
  } else {
    if (p.directionThin && !p.directionIsOverride) {
      wrap.append(Object.assign(el("div", "mini warn"), {
        textContent: "No Action and no storyboard description on this shot — Generate will send little more than the camera line below. Add direction, or write an override.",
        style: "margin-bottom:4px",
      }));
    }
    wrap.append(promptBox("Shot direction", "badge-seed", p.direction || "", p.directionIsOverride, shotField(shot, "videoPromptOverride")));
  }
  return wrap;
}

function promptBox(title, badge, text, isOverride, onChange) {
  const b = el("div", "promptbox");
  const h = el("div", "ph");
  h.append(Object.assign(el("b", badge), { textContent: title }));
  if (isOverride) h.append(Object.assign(el("span", "pill warn"), { textContent: "edited", style: "margin-left:6px" }));
  h.append(el("div", "sp", ""));
  h.querySelector(".sp").style.flex = "1";
  if (isOverride && onChange) {
    const rs = el("button", null, "Reset to auto");
    rs.style.cssText = "padding:3px 9px;font-size:11px;margin-right:4px";
    rs.onclick = () => onChange("");
    h.append(rs);
  }
  const cp = el("button", null, "Copy");
  cp.style.cssText = "padding:3px 9px;font-size:11px";
  h.append(cp);
  b.append(h);
  if (onChange) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.rows = Math.min(14, Math.max(3, text.split("\n").length + 1));
    ta.style.cssText = "width:100%;box-sizing:border-box;background:#0a0d12;border:1px solid var(--line);border-radius:6px;padding:8px;color:#cfd6e2;font-family:ui-monospace,monospace;font-size:12px;white-space:pre-wrap";
    ta.onchange = () => onChange(ta.value);
    cp.onclick = () => { navigator.clipboard.writeText(ta.value); cp.textContent = "Copied"; setTimeout(() => { cp.textContent = "Copy"; }, 1200); };
    b.append(ta);
  } else {
    cp.onclick = () => { navigator.clipboard.writeText(text); cp.textContent = "Copied"; setTimeout(() => { cp.textContent = "Copy"; }, 1200); };
    b.append(Object.assign(document.createElement("pre"), { textContent: text }));
  }
  return b;
}

// anchorShotId keeps that shot in view across the re-render (see
// withShotAnchor) instead of restoring the raw scroll offset, which can land
// on different content once anything elsewhere on the page changes height.
async function refreshPrompts(anchorShotId) {
  PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`);
  if (anchorShotId) { withShotAnchor(anchorShotId, renderEpisode); return; }
  const y = scrollY;
  renderEpisode();
  scrollTo(0, y);
}

// Shots the user has expanded stay expanded across re-renders (every edit
// re-renders the episode; before this, each one collapsed the open shot).
const OPEN_SHOTS = new Set();

// Same problem, worse consequence: a beat's image picker (Change image) can
// hold dozens of storyboard thumbnails across every scene. Picking one used
// to close it as a side effect of the reload that follows, collapsing that
// whole block right where you were working — near the top of a long page,
// with nothing above to compensate, that reads as the page jumping to the
// very top even though withShotAnchor did the correct, only-possible thing
// with the space it had. Keyed by beat id, value is the tab to reopen on
// ("gen" default when absent from the map but the beat id IS a key).
const OPEN_PICKERS = new Map();

// Storyboard rows the user has expanded, same pattern as OPEN_SHOTS — keyed
// by BEAT id, not shot id (a shot can hold several storyboard frames, each
// its own row). Starts empty: every row begins collapsed, same as shots do,
// which is the point (Sept 2026 — there was previously no way to collapse a
// board row at all short of an action like adding/deleting its image; the
// editable label+description fields spanned the full row width with nothing
// left to click as a toggle). A row auto-expands regardless of this set
// when its own image picker is open (OPEN_PICKERS) — the picker lives in the
// collapsed-away body, so it would otherwise be invisible.
const OPEN_BOARD_ROWS = new Set();

// ---------------- boot ----------------

$("#navLib").onclick = renderLibrary;

(async () => {
  try {
    const h = await api("/api/health");
    $("#drivers").textContent = `schema v${h.schemaVersion} · fal ${h.drivers.fal && h.drivers.fal.ready ? "✓" : "—"} · gemini ${h.drivers.gemini && h.drivers.gemini.ready ? "✓" : "—"}`;
    GRAMMAR = await api("/api/grammar");
    const m = /#ep=([^&]+)/.exec(location.hash);
    const sm = /[#&]series=([^&]+)/.exec(location.hash);
    if (m) await openEpisode(decodeURIComponent(m[1]), sm ? decodeURIComponent(sm[1]) : null);
    else await renderLibrary();
  } catch (e) { app().innerHTML = ""; fail(e); }
})();

// ---------------- development: screenplay + gates ----------------

let SCRIPT_FILES_CACHE = null;
let LAST_PARSE = null; // { path, single, scenes?|slice?, episodes? }

function developmentPanel() {
  const c = el("div", "card");
  const hr = el("div", "row");
  hr.append(Object.assign(el("h2"), { textContent: "Development — script", style: "flex:1" }));
  const rescan = el("button", null, "Find scripts");
  rescan.onclick = () => loadScriptFiles(c);
  hr.append(rescan);
  c.append(hr);
  c.append(Object.assign(el("div", "mini", "devFilesHint"), { textContent: "Looks in this episode's 00_script/ and the series' Scripts/ folder." }));
  c.append(Object.assign(el("div"), { id: "devFileList" }));
  c.append(Object.assign(el("div"), { id: "devParsePreview" }));

  if ((EP.scenes || []).length) {
    const sr = el("div", "row"); sr.style.marginTop = "10px";
    sr.append(Object.assign(el("div", "mini"), { textContent: `${EP.scenes.length} scenes on file for this episode.`, style: "flex:1" }));
    const draft = el("button", null, "Draft shot skeletons from scenes");
    draft.title = "One shot per scene, carrying over INT/EXT/location/time. A starting skeleton, not a finished shot list.";
    draft.onclick = async () => {
      draft.disabled = true; draft.textContent = "Drafting…";
      try {
        await post("/api/episode/shots/draft-from-scenes", { dir: EP.dir });
        PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`);
        await reloadEpisode();
      } catch (e) { fail(e); draft.disabled = false; draft.textContent = "Draft shot skeletons from scenes"; }
    };
    sr.append(draft);
    c.append(sr);

    const hookRow = el("div", "grid g2"); hookRow.style.marginTop = "8px";
    hookRow.append(field("Hook (G0)", EP.hook, (v) => { EP.hook = v; saveEp(); }));
    hookRow.append(field("Cliffhanger (G0)", EP.cliffhanger, (v) => { EP.cliffhanger = v; saveEp(); }));
    c.append(hookRow);
  }
  return c;
}

async function loadScriptFiles(card) {
  const list = card.querySelector("#devFileList");
  list.innerHTML = "Searching…";
  try {
    const q = `dir=${encodeURIComponent(EP.dir)}${SERIES_DIR ? `&seriesDir=${encodeURIComponent(SERIES_DIR)}` : ""}`;
    const { files } = await api(`/api/screenplay/files?${q}`);
    SCRIPT_FILES_CACHE = files;
    list.innerHTML = "";
    if (!files.length) { list.append(Object.assign(el("div", "empty"), { textContent: "No .fdx/.fountain files found." })); return; }
    files.forEach((f) => {
      const row = el("div", "eprow");
      row.append(Object.assign(el("div"), { textContent: f.name, style: "flex:1" }));
      row.append(Object.assign(el("span", "pill"), { textContent: f.from }));
      const b = el("button", null, "Parse");
      b.onclick = () => parseScriptFile(card, f.path);
      row.append(b);
      list.append(row);
    });
  } catch (e) { list.innerHTML = ""; fail(e); }
}

async function parseScriptFile(card, path, episodeNumber) {
  const prev = card.querySelector("#devParsePreview");
  prev.innerHTML = "Parsing…";
  try {
    let url = `/api/screenplay/parse?path=${encodeURIComponent(path)}`;
    if (episodeNumber) url += `&episode=${episodeNumber}`;
    const parsed = await api(url);
    LAST_PARSE = parsed;
    prev.innerHTML = "";

    if (!parsed.single && !episodeNumber) {
      // Combined multi-episode file — offer a picker instead of guessing.
      const box = el("div", "card");
      box.style.cssText = "margin:10px 0 0;background:var(--panel2)";
      box.append(Object.assign(el("div", "mini"), { textContent: `This file covers ${parsed.episodes.length} episodes (${parsed.scenes} scenes total). Pick one to slice out:` }));
      const row = el("div", "row"); row.style.marginTop = "8px";
      parsed.episodes.forEach((n) => {
        const b = el("button", null, `Episode ${n}`);
        b.onclick = () => parseScriptFile(card, path, n);
        row.append(b);
      });
      box.append(row);
      prev.append(box);
      return;
    }

    const scenes = parsed.single ? parsed.scenes : parsed.slice.scenes;
    const characters = parsed.single ? parsed.characters : parsed.slice.characters;
    prev.append(parsePreviewBox(path, scenes, characters, episodeNumber));
  } catch (e) { prev.innerHTML = ""; fail(e); }
}

function parsePreviewBox(path, scenes, characters, episodeNumber) {
  const box = el("div", "card");
  box.style.cssText = "margin:10px 0 0;background:var(--panel2)";
  const hr = el("div", "row");
  hr.append(Object.assign(el("h3"), { textContent: `${scenes.length} scenes${episodeNumber ? ` — episode ${episodeNumber}` : ""}`, style: "flex:1;font-size:13px" }));
  hr.append(Object.assign(el("span", "mini"), { textContent: `${characters.length} characters` }));
  const imp = el("button", "primary", "Import into this episode");
  imp.onclick = async () => {
    imp.disabled = true; imp.textContent = "Importing…";
    try {
      await post("/api/episode/scenes/import", { dir: EP.dir, scenes, scriptPath: path });
      PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`);
      await reloadEpisode();
    } catch (e) { fail(e); imp.disabled = false; imp.textContent = "Import into this episode"; }
  };
  hr.append(imp);
  box.append(hr);

  const tbl = el("div"); tbl.style.marginTop = "8px";
  scenes.forEach((s) => {
    const row = el("div", "eprow");
    row.append(Object.assign(el("span", "mono"), { textContent: s.number, style: "min-width:24px" }));
    row.append(Object.assign(el("div"), { textContent: s.heading || "(no slugline)", style: "flex:1" }));
    if (s.characters.length) row.append(Object.assign(el("span", "pill"), { textContent: s.characters.join(", ") }));
    if (s.extras.length) row.append(Object.assign(el("span", "pill warn"), { textContent: `+${s.extras.length} extra` }));
    if (s.props.length) row.append(Object.assign(el("span", "pill"), { textContent: `${s.props.length} prop` }));
    tbl.append(row);
  });
  box.append(tbl);
  return box;
}



let AUDIT_TOKEN = 0;

function auditBlock() {
  const box = el("div"); box.id = "auditBlock"; box.style.marginTop = "10px";
  box.append(Object.assign(el("div", "mini"), { textContent: "Loading new-asset audit…" }));
  loadAudit(box, ++AUDIT_TOKEN);
  return box;
}

// `token` guards against a slow earlier fetch overwriting a box that a newer
// render already replaced — renderEpisode() rebuilds the DOM synchronously
// but this fetch is async, so two can be in flight after a rapid double-click.
async function loadAudit(box, token) {
  try {
    const q = `dir=${encodeURIComponent(EP.dir)}${SERIES_DIR ? `&seriesDir=${encodeURIComponent(SERIES_DIR)}` : ""}`;
    const audit = await api(`/api/episode/audit?${q}`);
    if (token !== AUDIT_TOKEN) return;
    box.innerHTML = "";
    const hr = el("div", "row");
    hr.append(Object.assign(el("h3"), { textContent: "New-asset audit", style: "flex:1;font-size:13px" }));
    hr.append(Object.assign(el("span", "pill ok"), { textContent: `${audit.summary.standing} standing` }));
    hr.append(Object.assign(el("span", "pill warn"), { textContent: `${audit.summary.new} new` }));
    box.append(hr);
    if (!audit.new.length) {
      box.append(Object.assign(el("div", "mini"), { textContent: "Nothing new — every character/location/prop the script calls for is already in the series registry.", style: "margin-top:6px" }));
    }
    const overrides = EP.assetAuditOverrides || {};
    audit.new.forEach((row) => {
      const key = `${row.type}:${row.name.trim().toLowerCase().replace(/\s+/g, " ")}`;
      const r = el("div", "eprow");
      r.append(Object.assign(el("span", "pill"), { textContent: row.type }));
      r.append(Object.assign(el("div"), { textContent: row.name }));
      // Images this episode already has under a matching name — hover to
      // enlarge — so waive/un-waive is decided by eye, not from a bare name.
      const thumbs = el("div"); thumbs.style.cssText = "flex:1;display:flex;gap:6px;align-items:center";
      (row.matches || []).slice(0, 4).forEach((m) => {
        const t = imageThumb(m.path, () => window.open(mediaURL(m.path), "_blank"), { width: "36px", height: "36px" });
        t.title = `${m.name} — hover to enlarge, click to open full-size`;
        thumbs.append(t);
      });
      if (!(row.matches || []).length) thumbs.append(Object.assign(el("span", "mini"), { textContent: "no matching image in this episode" }));
      r.append(thumbs);
      r.append(Object.assign(el("span", "mini"), { textContent: `scene ${row.scenes.join(", ")}` }));
      if (overrides[key]) {
        r.append(Object.assign(el("span", "pill ok"), { textContent: overrides[key] }));
        const un = el("button", null, "Un-waive");
        un.onclick = async () => { await post("/api/episode/audit/override", { dir: EP.dir, assetType: row.type, name: row.name, clear: true }); await reloadEpisode(); };
        r.append(un);
      } else {
        const waive = el("button", null, "Waive");
        waive.title = "Mark as deliberately deferred — doesn't block G2, but nothing is added to the registry.";
        waive.onclick = async () => { await post("/api/episode/audit/override", { dir: EP.dir, assetType: row.type, name: row.name, resolution: "waived" }); await reloadEpisode(); };
        r.append(waive);
        if (SERIES_DIR) {
          const approve = el("button", "primary", "Add to registry");
          approve.title = "Register as a canon asset. Build the actual reference image in the Identity Vault (Phase 2) — this only reserves the name.";
          approve.onclick = async () => {
            await post("/api/series/registry/add", { seriesDir: SERIES_DIR, assetType: row.type, name: row.name, approved: true });
            await reloadEpisode();
          };
          r.append(approve);

          // Naming mismatch, not a new asset — "Serge" vs registry's "Serge
          // Stitch". Linking as an alias makes every episode's audit count
          // this name as standing from now on, instead of Waive (which only
          // silences THIS episode's warning and creates no lasting link).
          const candidates = (audit.registry || []).filter((a) => a.type === row.type);
          if (candidates.length) {
            const sel = document.createElement("select");
            sel.style.cssText = "max-width:160px";
            const ph = document.createElement("option");
            ph.value = ""; ph.textContent = "Link as alias to…"; ph.selected = true; ph.disabled = true;
            sel.append(ph);
            candidates.forEach((a) => {
              const o = document.createElement("option"); o.value = a.id; o.textContent = a.name;
              sel.append(o);
            });
            sel.onchange = async () => {
              if (!sel.value) return;
              try {
                await post("/api/series/registry/alias", { seriesDir: SERIES_DIR, assetId: sel.value, alias: row.name });
                await reloadEpisode();
              } catch (e) { fail(e); }
            };
            r.append(sel);
          }
        }
      }
      box.append(r);
    });
  } catch (e) { box.innerHTML = ""; fail(e); }
}

// ---------------- storyboard board (feeds gate G3) ----------------

// The most reference images ANY currently offered video model accepts
// (rates.js's imageParams, checked against each model's live fal schema
// 2026-09-25 — every one of them tops out at 2: a start frame and an end
// frame, none take a third). Read live from /api/models rather than
// hardcoded, so a future model with a different count updates this
// automatically. Falls back to 1 before models have loaded.
function maxVideoImageSlots() {
  const models = (MODELS && MODELS.video) || [];
  return models.reduce((max, m) => Math.max(max, (m.imageParams || []).length || 1), 1);
}

function boardPanel() {
  const c = el("div", "card");
  const hr = el("div", "row");
  hr.append(Object.assign(el("h2"), { textContent: "Storyboard — board approval", style: "flex:1" }));
  const stats = beatStillStats(EP.shots);
  hr.append(Object.assign(el("span", "pill" + (stats.approved === stats.total && stats.total ? " ok" : " warn")), { textContent: `${stats.approved}/${stats.total} approved` }));
  c.append(hr);
  c.append(Object.assign(el("div", "mini"), { textContent: "Gate G3 needs every keyframe still approved here. Never generate video before this gate — the asymmetry is real: a bad board frame is a cheap regen, a bad video clip is an expensive one." }));

  const groups = sceneGroups();
  if (!groups.length) {
    c.append(Object.assign(el("div", "empty"), { textContent: "No scenes or shots yet — import the script or build the shot list first." }));
    return c;
  }

  const list = el("div"); list.style.marginTop = "4px";
  groups.forEach((g) => {
    list.append(sceneHeader(g, "board"));
    if (!g.shots.length) { list.append(emptySceneRow(g)); return; }
    g.shots.forEach((shot) => {
      const kf = (shot.beats || []).filter((b) => b.keyframe);
      if (!kf.length) { list.append(noStoryboardRow(shot)); return; }
      const approved = kf.filter((b) => b.frame && b.frame.approved).length;
      const slots = maxVideoImageSlots();
      const startEnd = resolveStartEndBeats(shot);
      if (approved > slots) {
        const pill = el("button", "pill warn", `${approved} storyboards — ${slots} used in Generate  ⓘ`);
        pill.style.cssText = "margin:4px 0 2px 4px;cursor:pointer";
        pill.title = "Click to read why, and how to choose which two";
        pill.onclick = () => alert(
          `Up to 5 storyboards are allowed on one shot so you can compare different start/end combinations. `
          + `When you generate, most video models here only take ${slots}${slots > 1 ? " — a start frame and an end frame" : ""}, `
          + `so the rest stay on the board for comparison only.\n\n`
          + `The exception is "Seedance 2.5 — references" (pick it under Generate video): it sends ALL approved storyboards plus the shot's character/location assets.\n\n`
          + `Pick which two below: click "1 · start" or "2 · end" on any approved storyboard's row. `
          + `Left unpicked, the first approved storyboard is used as start and the last as end.`,
        );
        list.append(pill);
      }
      (shot.beats || []).forEach((beat, i) => {
        if (!beat.keyframe) return;
        list.append(boardRow(shot, beat, i, approved > slots && slots >= 2 ? startEnd : null));
      });
    });
  });
  c.append(list);
  return c;
}

// A shot whose storyboards were all removed still gets a row, so there's a
// way to give it one again without going to the Shots list.
function noStoryboardRow(shot) {
  const r = el("div", "eprow");
  const thumb = el("div"); thumb.style.cssText = "width:64px;height:64px;border-radius:6px;background:#0a0d12;flex-shrink:0;display:flex;align-items:center;justify-content:center;text-align:center";
  thumb.append(Object.assign(el("div", "mini"), { textContent: "no storyboard" }));
  r.append(thumb);
  const mid = el("div"); mid.style.flex = "1";
  mid.append(Object.assign(el("div"), { textContent: `${shot.sceneNum}${shot.shotCode} — ${shot.label || "(untitled shot)"}` }));
  mid.append(Object.assign(el("div", "mini"), { textContent: "This shot has no storyboard frames." }));
  const actions = el("div", "row-actions");
  const add = el("button", null, "+ Add storyboard");
  add.onclick = async () => {
    try {
      // Turn the first beat back into a storyboard frame (keeps any image it
      // had before it was removed).
      const b = shot.beats[0];
      await post("/api/episode/beat/update", { dir: EP.dir, shotId: shot.id, beatId: b.id, patch: { keyframe: true } });
      await reloadEpisode(shot.id);
    } catch (e) { fail(e); }
  };
  const up = el("button", null, "↑"); up.title = "Move this shot up one place in the scene (renumbers)"; up.onclick = () => moveShot(shot, -1);
  const down = el("button", null, "↓"); down.title = "Move this shot down one place in the scene (renumbers)"; down.onclick = () => moveShot(shot, 1);
  const addShot = el("button", null, "+ Shot after"); addShot.onclick = () => insertShotAfter(shot);
  const del = el("button", "danger", "Delete shot"); del.onclick = () => deleteShot(shot);
  actions.append(add, up, down, addShot, del);
  mid.append(actions);
  r.append(mid);
  return r;
}

function beatStillStats(shots) {
  let total = 0, approved = 0;
  for (const s of shots || []) for (const b of s.beats || []) {
    if (!b.keyframe) continue;
    total++;
    if (b.frame && b.frame.approved) approved++;
  }
  return { total, approved };
}

// Same hover/click affordance as versionThumb (the Version tray's video
// takes), for a still image: hover floats a larger preview right next to the
// thumbnail so detail is checkable without clicking anything; click toggles
// a full-size inline view via onClick. A still has no motion to preview, so
// hover shows a bigger static frame instead of a looping clip — same idea,
// the image equivalent.
function imageThumb(path, onClick, size) {
  // .ver-thumb's own overflow:hidden (needed to crop the small thumbnail)
  // would also clip an absolutely-positioned hover preview escaping the box —
  // it's a child of the same element. So the crop lives on an INNER wrapper
  // instead, and `wrap` itself stays overflow:visible. `size` (e.g. {width:
  // "64px", height: "64px"}) overrides .ver-thumb's default 42x74 video
  // aspect when a caller needs a different box (boardRow wants a square).
  const boxCss = size ? `width:${size.width};height:${size.height};` : "";
  const wrap = el("div", "ver-thumb"); wrap.style.cssText = `position:relative;overflow:visible;${boxCss}`;
  const inner = el("div"); inner.style.cssText = "width:100%;height:100%;overflow:hidden;border-radius:5px;background:#0a0d12";
  const img = el("img"); img.src = mediaURL(path, 160); img.loading = "lazy";
  img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block";
  inner.append(img);
  wrap.append(inner);

  let hoverPreview = null;
  wrap.onmouseenter = () => {
    if (hoverPreview && hoverPreview.isConnected) return;
    hoverPreview = document.createElement("img");
    hoverPreview.src = mediaURL(path, 640);
    // Centered vertically on the thumbnail (not top-aligned) so it doesn't
    // depend on the thumbnail's position in a short viewport — a tall preview
    // top-aligned to a thumb near the bottom of the screen runs off the fold.
    hoverPreview.style.cssText = "max-width:360px;max-height:min(480px,90vh);width:auto;height:auto;object-fit:contain;border:1px solid var(--line);border-radius:6px;background:#0a0d12;box-shadow:0 8px 24px rgba(0,0,0,.6);pointer-events:none";
    placePop(wrap, hoverPreview, 360);
    hoverPreview.addEventListener("load", () => { if (hoverPreview) placePop(wrap, hoverPreview, hoverPreview.getBoundingClientRect().width || 360); });
  };
  wrap.onmouseleave = () => {
    if (!hoverPreview) return;
    hoverPreview.remove(); OPEN_POPS.delete(hoverPreview);
    hoverPreview = null;
  };

  wrap.title = "Hover for a larger preview, click to open full-size";
  wrap.onclick = onClick;
  return wrap;
}

// startEnd (from resolveStartEndBeats), passed only when a shot has more
// approved storyboards than any model can use — that's the only case where
// picking matters. null everywhere else so rows render exactly as before.
// Start / End pick buttons for one storyboard. Not toggles: clicking "✓ 2 ·
// end" used to clear the pick back to automatic, which on 5a (Shawn,
// 2026-10-08) chose the same last storyboard again — it looked locked. The
// current pick shows ✓ and is replaced by picking another storyboard.
function startEndButtons(shot, beat, isStart, isEnd, wrap = (fn) => fn) {
  const setPick = (patch) => post("/api/episode/shot/update", { dir: EP.dir, shotId: shot.id, patch }).then(() => reloadEpisode(shot.id)).catch(fail);
  const mk = (on, label, title) => { const b = el("button", on ? "primary" : null, on ? `✓ ${label}` : label); b.style.cssText = "font-size:11px;padding:3px 8px"; b.title = title; return b; };
  const bs = mk(isStart, "1 · start", isStart ? "This storyboard is the start frame. Pick another storyboard's start to replace it." : isEnd ? "This is the end frame — pick another end first" : "Send this storyboard as the start frame");
  const be = mk(isEnd, "2 · end", isEnd ? "This storyboard is the end frame. Pick another storyboard's end to replace it." : isStart ? "This is the start frame — pick another start first" : "Send this storyboard as the end frame");
  bs.disabled = isStart || isEnd; be.disabled = isEnd || isStart;
  bs.onclick = wrap(() => setPick({ startBeatId: beat.id }));
  be.onclick = wrap(() => setPick({ endBeatId: beat.id }));
  const out = [bs, be];
  if ((isStart || isEnd) && (shot.startBeatId || shot.endBeatId)) {
    const auto = el("button", null, "Auto");
    auto.style.cssText = "font-size:11px;padding:3px 8px";
    auto.title = "Clear both picks: first approved storyboard as start, last as end";
    auto.onclick = wrap(() => setPick({ startBeatId: null, endBeatId: null }));
    out.push(auto);
  }
  return out;
}

function boardRow(shot, beat, index, startEnd) {
  // Collapsible now (Sept 2026) — previously a plain always-expanded div,
  // the only thing that ever changed its visible size was an action (adding
  // or deleting its image). The editable label+description fields spanned
  // the full row width with nothing left over to click as a toggle, so
  // there was genuinely no way to collapse a board row. Same <details>
  // pattern as shotBlock, keyed by BEAT id (not shot id — a shot can hold
  // several storyboard frames, each its own row) via data-beat-id, a
  // DIFFERENT attribute from shotBlock's data-shot-id so withShotAnchor's
  // lookup (which must only ever match the Shots list's own <details>) can
  // never accidentally match a board row instead.
  const d = el("details", "board");
  d.dataset.beatId = beat.id;
  d.dataset.boardShot = shot.id; // scroll anchor for edits made in this panel — see anchorCandidates
  d.open = OPEN_BOARD_ROWS.has(beat.id) || OPEN_PICKERS.has(beat.id);
  // Which of this shot's storyboards is this? Rows used to read identically
  // ("6h · mid — …") once a shot had two or more, which made it easy to edit
  // or delete the wrong one.
  const kfBeats = (shot.beats || []).filter((b) => b.keyframe);
  const slot = kfBeats.findIndex((b) => b.id === beat.id) + 1;
  const slotText = kfBeats.length > 1 ? `storyboard ${slot} of ${kfBeats.length} · ${beat.role}` : beat.role;
  if (OPEN_PICKERS.has(beat.id)) d.classList.add("picking");
  d.ontoggle = () => {
    if (d.open) { OPEN_BOARD_ROWS.add(beat.id); return; }
    OPEN_BOARD_ROWS.delete(beat.id);
    // Manually collapsing a row with its picker open should stick — without
    // this, OPEN_PICKERS (unaffected by this toggle) would still have the
    // beat on the next reload, forcing the row back open on its own.
    OPEN_PICKERS.delete(beat.id);
  };

  // Any control living in the SUMMARY must stop its click from also
  // toggling the row open/closed — same guard shotBlock's own summary-line
  // buttons already use.
  const guard = (fn) => (e) => { e.preventDefault(); e.stopPropagation(); fn(); };

  const isStart = !!(startEnd && startEnd.start && startEnd.start.id === beat.id);
  const isEnd = !!(startEnd && startEnd.end && startEnd.end.id === beat.id);

  const sm = el("summary");
  // A plain block, not flex — it holds the flex control row below PLUS an
  // optional full-size preview image, which must drop onto its own line.
  const smRow = el("div"); smRow.style.cssText = "display:flex;align-items:center;gap:10px";
  sm.append(smRow);

  // The thumbnail's click-to-enlarge has to keep working even while the row
  // itself is collapsed (it's a quick look, not an edit), so the enlarged
  // image is appended into the SUMMARY itself, not the collapsible body.
  let expandedImg = null;
  const toggleExpanded = guard(() => {
    if (!(beat.frame && beat.frame.path)) return;
    if (expandedImg) { expandedImg.remove(); expandedImg = null; return; }
    expandedImg = el("div"); expandedImg.style.cssText = "margin-top:8px;text-align:center";
    const full = document.createElement("img");
    full.src = mediaURL(beat.frame.path);
    full.style.cssText = "max-width:100%;max-height:70vh;border-radius:8px;border:1px solid var(--line)";
    expandedImg.append(full);
    sm.append(expandedImg);
  });

  if (beat.frame && beat.frame.path) {
    const it = imageThumb(beat.frame.path, toggleExpanded, { width: "48px", height: "48px" });
    it.style.flexShrink = "0";
    if (isStart || isEnd) {
      it.style.outline = "2px solid var(--ok)";
      it.style.outlineOffset = "2px";
      it.style.borderRadius = "5px";
      const badge = el("span", null, isStart ? "1" : "2");
      badge.title = isStart ? "Used as the start frame" : "Used as the end frame";
      badge.style.cssText = "position:absolute;top:-6px;left:-6px;width:18px;height:18px;border-radius:50%;"
        + "background:var(--ok);color:#04140b;font-size:11px;font-weight:700;line-height:18px;text-align:center;"
        + "box-shadow:0 0 0 2px var(--panel)";
      it.append(badge);
    }
    const imgEl = it.querySelector("img");
    if (imgEl) imgEl.onerror = () => { it.innerHTML = ""; it.append(Object.assign(el("div", "mini"), { textContent: "missing" })); it.onclick = null; it.title = ""; };
    smRow.append(it);
  } else {
    const thumb = el("div"); thumb.style.cssText = "width:48px;height:48px;border-radius:6px;overflow:hidden;background:#0a0d12;flex-shrink:0;display:flex;align-items:center;justify-content:center";
    thumb.append(Object.assign(el("div", "mini"), { textContent: "no frame" }));
    smRow.append(thumb);
  }

  smRow.append(Object.assign(el("span", "code"), { textContent: `${shot.sceneNum}${shot.shotCode}` }));
  smRow.append(Object.assign(el("span", "lbl"), { textContent: `${slotText} — ${shot.label || beat.desc || "(untitled)"}` }));
  const pickingPill = Object.assign(el("span", "pill warn"), { textContent: "choosing image…", title: "This row's image picker is open — a pick lands on THIS storyboard" });
  if (OPEN_PICKERS.has(beat.id)) smRow.append(pickingPill);
  // Live highlight: same look the moment a picker opens or closes, not only
  // after the next reload.
  const setPicking = (on) => { d.classList.toggle("picking", on); if (on) smRow.insertBefore(pickingPill, appBtnRef()); else pickingPill.remove(); };
  const appBtnRef = () => smRow.querySelector("button");

  // Approve stays on the summary (not tucked in the collapsed body) — it's
  // the action Shawn does over and over while scanning a whole scene's
  // boards, and gating it behind an expand click would undo the point of
  // collapsing rows in the first place.
  const approved = !!(beat.frame && beat.frame.approved);
  const appBtn = el("button", approved ? "primary" : null, approved ? "✓ Approved" : "Approve");
  appBtn.disabled = !(beat.frame && beat.frame.path);
  appBtn.onclick = guard(async () => {
    try {
      await post("/api/episode/beat/frame", { dir: EP.dir, shotId: shot.id, beatId: beat.id, path: beat.frame.path, approved: !approved });
      await reloadEpisode(shot.id);
    } catch (e) { fail(e); }
  });
  if (startEnd && approved) {
    const se = el("span"); se.style.cssText = "display:flex;gap:4px;flex-shrink:0";
    se.append(...startEndButtons(shot, beat, isStart, isEnd, guard));
    smRow.append(se);
  }
  smRow.append(appBtn);

  // Shot-level controls live ONLY on the shot's first storyboard row, so a
  // frame's own buttons can't be mistaken for "delete the whole shot" — kept
  // on the summary too (same reasoning as Approve: structural, occasional,
  // but not worth an expand click to reach).
  const firstRow = index === (shot.beats || []).findIndex((b) => b.keyframe);
  if (firstRow) {
    const shotActs = el("span", "row-actions"); shotActs.style.marginLeft = "auto";
    const scene = (EP.shots || []).filter((x) => x.sceneNum === shot.sceneNum);
    const pos = scene.indexOf(shot);
    const up = el("button", null, "↑"); up.title = "Move this shot up one place in the scene (renumbers)";
    up.disabled = pos === 0; up.onclick = guard(() => moveShot(shot, -1));
    const down = el("button", null, "↓"); down.title = "Move this shot down one place in the scene (renumbers)";
    down.disabled = pos === scene.length - 1; down.onclick = guard(() => moveShot(shot, 1));
    shotActs.append(up, down);
    if (firstInScene(shot)) {
      const addBefore = el("button", null, "+ Shot before");
      addBefore.title = `Add a new shot at the top of scene ${shot.sceneNum}, ahead of ${shot.sceneNum}${shot.shotCode}`;
      addBefore.onclick = guard(() => insertShotBefore(shot));
      shotActs.append(addBefore);
    }
    const addShot = el("button", null, "+ Shot after");
    addShot.title = `Add a new shot right after ${shot.sceneNum}${shot.shotCode} (later shots renumber)`;
    addShot.onclick = guard(() => insertShotAfter(shot));
    const delShot = el("button", "danger", "Delete shot");
    delShot.title = `Delete shot ${shot.sceneNum}${shot.shotCode} and ALL of its storyboards`;
    delShot.onclick = guard(() => deleteShot(shot));
    shotActs.append(addShot, delShot);
    smRow.append(shotActs);
  }
  d.append(sm);

  // Everything below is the collapsible BODY — editing, the image picker,
  // and the rest of the occasional (not scan-every-row) actions.
  const body = el("div", "body");

  // The shot label and the beat description are both edited in place here.
  // A label belongs to the SHOT (shared by its start/end rows), so saving it
  // reloads to update the sibling rows too.
  const titleLine = el("div"); titleLine.style.cssText = "display:flex;align-items:center;gap:6px";
  titleLine.append(Object.assign(el("span"), { textContent: `${shot.sceneNum}${shot.shotCode} · ${slotText} —`, style: "white-space:nowrap" }));
  titleLine.append(inlineEdit(shot.label, async (v) => {
    await post("/api/episode/shot/update", { dir: EP.dir, shotId: shot.id, patch: { label: v } });
    await reloadEpisode(shot.id);
  }, { placeholder: "(untitled shot — click to name)" }));
  body.append(titleLine);
  body.append(inlineEdit(beat.desc || "", async (v) => {
    await post("/api/episode/beat/update", { dir: EP.dir, shotId: shot.id, beatId: beat.id, patch: { desc: v } });
    beat.desc = v;
    refreshPrompts(shot.id);
  }, { multiline: true, placeholder: shot.action || "(no description — click to add)" }));

  // Role — a shot whose first storyboard was deleted ends up with only "mid"
  // rows; this lets you say which one is the start (or end) again.
  if (beat.keyframe) {
    const roleSel = document.createElement("select"); roleSel.style.cssText = "width:auto;margin-top:8px";
    ["start", "mid", "end"].forEach((r) => { const o = document.createElement("option"); o.value = r; o.textContent = r; if (beat.role === r) o.selected = true; roleSel.append(o); });
    roleSel.title = "Which moment of the shot this storyboard is";
    roleSel.onchange = async () => {
      try { await post("/api/episode/beat/update", { dir: EP.dir, shotId: shot.id, beatId: beat.id, patch: { role: roleSel.value } }); PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`); await reloadEpisode(shot.id); }
      catch (e) { fail(e); roleSel.value = beat.role; }
    };
    const roleWrap = el("div", "row"); roleWrap.style.cssText = "gap:6px;align-items:center";
    roleWrap.append(Object.assign(el("span", "mini"), { textContent: "Role", style: "margin-top:8px" }), roleSel);
    body.append(roleWrap);
  }

  const actions = el("div", "row-actions"); actions.style.marginTop = "8px";
  const addStill = el("button", null, beat.role === "end" ? "+ Storyboard before" : "+ Storyboard after");
  addStill.title = `Add another storyboard frame to this shot, right ${beat.role === "end" ? "before" : "after"} this one`;
  addStill.onclick = () => insertBeatAfter(shot, beat);
  actions.append(addStill, moveToSelect(shot, beat));
  body.append(actions);
  body.append(shotRefsSection(shot, `board-${beat.id}`));

  const pickerHost = el("div"); pickerHost.style.marginTop = "6px";
  body.append(pickerHost);

  const controls = el("div", "row"); controls.style.cssText = "flex-wrap:wrap;gap:6px;margin-top:8px";


  // Carryover / imported footage with no storyboard: one click takes the
  // storyboard from the clip itself (the selected take, else the newest).
  const takesDone = (shot.versions || []).filter((v) => v.path && v.state === "done");
  if (!(beat.frame && beat.frame.path) && takesDone.length) {
    const primarySelected = (shot.selectedVersions || [])[0];
    const take = takesDone.find((v) => v.id === primarySelected) || takesDone[takesDone.length - 1];
    const fv = el("button", null, "Frame from video");
    fv.title = `This shot already has video — use the ${beat.role === "end" ? "last" : beat.role === "mid" ? "middle" : "first"} frame of "${take.modelLabel || "the clip"}" as this storyboard`;
    fv.onclick = () => grabFrame(shot, beat, take);
    controls.append(fv);
  }
  const pickBtn = el("button", null, beat.frame && beat.frame.path ? "Change image" : "Set image");
  pickBtn.onclick = () => {
    if (pickerHost.children.length) { pickerHost.innerHTML = ""; OPEN_PICKERS.delete(beat.id); setPicking(false); return; }
    pickerHost.append(boardFramePicker(shot, beat));
    setPicking(true);
  };
  controls.append(pickBtn);
  // Reopens automatically after a reload — picking an image used to close
  // this picker as a side effect of the re-render (nothing re-showed it),
  // collapsing however many thumbnails it held right where Shawn was
  // working. See OPEN_PICKERS. (d.open above already forces the row open
  // whenever this is true, so the reopened picker is never hidden.)
  if (OPEN_PICKERS.has(beat.id)) pickerHost.append(boardFramePicker(shot, beat));

  // Deletes just THIS storyboard frame (the shot keeps its other frames).
  // A shot's last beat can't be deleted outright, so for a one-frame shot the
  // frame is turned off instead and the shot stays on the board as
  // "no storyboard". Either way: image stays on disk, and Undo brings it back.
  const rmBtn = el("button", null, "Delete storyboard");
  rmBtn.title = "Delete this storyboard frame only — the shot and its other frames stay";
  rmBtn.onclick = async () => {
    const label = `${shot.sceneNum}${shot.shotCode} · ${beat.role}`;
    const onlyBeat = (shot.beats || []).length === 1;
    if (!confirm(`Delete storyboard ${label}?\n\nOnly this frame goes — shot ${shot.sceneNum}${shot.shotCode} stays${onlyBeat ? " (as a shot with no storyboard)" : ""}. Any image stays on disk. Undo brings it back.`)) return;
    try {
      if (onlyBeat) await post("/api/episode/beat/update", { dir: EP.dir, shotId: shot.id, beatId: beat.id, patch: { keyframe: false } });
      else await post("/api/episode/beat/delete", { dir: EP.dir, shotId: shot.id, beatId: beat.id });
      await reloadEpisode(shot.id);
    } catch (e) { fail(e); }
  };
  body.append(controls);
  // Destructive, so it sits on its own line well clear of Change image —
  // the two used to be neighbours in the same row.
  const dangerRow = el("div", "dangerrow");
  dangerRow.append(rmBtn);
  body.append(dangerRow);

  d.append(body);
  return d;
}

// Three sources for a board frame, in the order Shawn actually wants them:
//  1. Generate — call the model directly, right here, with this shot's own
//     reference assets auto-attached. Writes straight into 03_storyboard/.
//  2. Keyframe library — browse THIS episode's own 03_storyboard/, grouped by
//     scene so it's never a flat wall of every still this episode has ever
//     produced.
//  3. From generated_imgs (manual) — the shared cross-project inbox, for a
//     still generated by hand outside the app (e.g. Claude's own Nano Banana
//     tool in a chat session). Kept as a fallback, not the default, and
//     filterable so 150 unrelated images from other productions don't have
//     to be scrolled past.
function boardFramePicker(shot, beat) {
  const wrap = el("div");
  const tabs = el("div", "row");
  const tGen = el("button", null, "Generate");
  const tLib = el("button", null, "Keyframe library");
  const tEarlier = el("button", null, "Earlier versions");
  tEarlier.title = "Stills from earlier work on this series — the old episode's keyframes, Keyframes/, Character images/";
  const tInbox = el("button", null, "From generated_imgs (manual)");
  const takes = (shot.versions || []).filter((v) => v.path && v.state === "done");
  const tTake = el("button", null, "From this shot's video");
  tTake.title = "Use a frame from one of this shot's clips: first frame for a start storyboard, last for an end, middle for a mid";
  tabs.append(tGen, tLib, tEarlier);
  if (takes.length) tabs.append(tTake);
  tabs.append(tInbox);
  const closeP = el("button", null, "✕ Close picker");
  closeP.title = "Close this image picker";
  closeP.style.marginLeft = "auto";
  closeP.onclick = async () => { OPEN_PICKERS.delete(beat.id); await reloadEpisode(shot.id); };
  tabs.append(closeP);
  wrap.append(tabs);
  const host = el("div"); host.style.marginTop = "8px"; wrap.append(host);

  const setActive = (btn) => { [tGen, tLib, tEarlier, tTake, tInbox].forEach((b) => { b.className = "pill" + (b === btn ? " on" : ""); }); };

  const applyFrame = async (path) => {
    await post("/api/episode/beat/frame", { dir: EP.dir, shotId: shot.id, beatId: beat.id, path, approved: false });
    // The picker has done its job: it used to reopen itself after the reload and
    // sit there open (Shawn, 2026-10-17).
    OPEN_PICKERS.delete(beat.id);
    await reloadEpisode(shot.id);
  };

  const showGenerate = () => {
    setActive(tGen); host.innerHTML = "";
    host.append(generatePane(shot, beat));
  };
  const showLibrary = async () => {
    setActive(tLib); host.innerHTML = "Loading…";
    try {
      const { files } = await api(`/api/episode/media?dir=${encodeURIComponent(EP.dir)}&sub=03_storyboard`);
      host.innerHTML = "";
      host.append(keyframeLibrary(files, (path) => applyFrame(path).catch(fail)));
    } catch (e) { host.innerHTML = ""; fail(e); }
  };
  const showEarlier = async () => {
    setActive(tEarlier); host.innerHTML = "Loading…";
    try {
      const q = `dir=${encodeURIComponent(EP.dir)}${SERIES_DIR ? `&seriesDir=${encodeURIComponent(SERIES_DIR)}` : ""}`;
      const { files } = await api(`/api/episode/earlier-media?${q}`);
      host.innerHTML = "";
      host.append(earlierPicker(files, shot, beat, async (f) => {
        try {
          // Copied in under its descriptive name, minus the OLD shot code
          // ("01d_4_int-day-workshop_…" → "int-day-workshop_…") — that number
          // belongs to the old shot list and would only mislead here.
          const filename = f.name.replace(/^\d+[a-z]*(_\d+[a-z]*)?_/i, "");
          const { path: newPath } = await post("/api/media/promote", { source: f.path, dir: EP.dir, destSub: "03_storyboard", filename });
          await applyFrame(newPath);
        } catch (e) { fail(e); }
      }));
    } catch (e) { host.innerHTML = ""; fail(e); }
  };
  const showTake = () => {
    setActive(tTake); host.innerHTML = "";
    const where = beat.role === "end" ? "last" : beat.role === "mid" ? "middle" : "first";
    host.append(Object.assign(el("div", "mini"), { textContent: `Click a clip to use its ${where} frame as this ${beat.role} storyboard:`, style: "margin-bottom:6px" }));
    const g = el("div", "assets");
    takes.forEach((v) => {
      const c = el("div", "asset"); c.style.cursor = "pointer";
      const t = imageThumb(v.path, () => grabFrame(shot, beat, v), { width: "100%", height: "80px" });
      t.title = `${v.modelLabel || v.path}\nClick to use its ${where} frame`;
      c.append(t);
      c.append(Object.assign(el("div", "an mini"), { textContent: `${(shot.selectedVersions || []).includes(v.id) ? "✓ " : ""}${v.modelLabel || v.path.split("/").pop()}` }));
      g.append(c);
    });
    host.append(g);
  };
  tTake.onclick = () => { OPEN_PICKERS.set(beat.id, "take"); showTake(); };
  const showInbox = () => {
    setActive(tInbox); host.innerHTML = "";
    host.append(inboxPickerFiltered(async (file) => {
      try {
        const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
        const beatIndex = (shot.beats || []).findIndex((b) => b.id === beat.id);
        const frameName = beatFrameName(shot, beat, beatIndex) + `.${ext}`;
        const { path: newPath } = await post("/api/media/promote", { source: file.name, fromInbox: true, dir: EP.dir, destSub: "03_storyboard", filename: frameName });
        await applyFrame(newPath);
      } catch (e) { fail(e); }
    }));
  };
  tGen.onclick = () => { OPEN_PICKERS.set(beat.id, "gen"); showGenerate(); };
  tLib.onclick = () => { OPEN_PICKERS.set(beat.id, "lib"); showLibrary(); };
  tEarlier.onclick = () => { OPEN_PICKERS.set(beat.id, "earlier"); showEarlier(); };
  tInbox.onclick = () => { OPEN_PICKERS.set(beat.id, "inbox"); showInbox(); };
  // Reopen to the tab Shawn had open before this reload — picking a keyframe-
  // library image is the common case, and always resetting to Generate would
  // mean re-clicking "Keyframe library" after every single pick.
  ({ gen: showGenerate, lib: showLibrary, earlier: showEarlier, inbox: showInbox, take: showTake }[OPEN_PICKERS.get(beat.id)] || showGenerate)();
  return wrap;
}

// Tab 1: generate a still in-session. Shows exactly what will be sent — the
// same Nano Banana prompt text shown elsewhere for copy/paste, plus the
// shot's own reference assets — before spending anything.
// Sticks across shots within the session — once Shawn picks GPT Image he
// probably wants it for the next few shots too, not reset every time.
let STILL_MODEL_ID = "gemini-3.1-flash-image-preview";
const FALLBACK_IMAGE_MODELS = [{ id: "gemini-3.1-flash-image-preview", label: "Nano Banana (Gemini)", driver: "gemini", usdPerImage: 0.04 }];
const waitHint = (driverName) => (driverName === "gemini" ? "~10–20s" : "~30–90s");

function generatePane(shot, beat) {
  const box = el("div");
  let manageOpen = false;

  function draw() {
    box.innerHTML = "";
    const p = (PROMPTS.shots || []).find((x) => x.id === shot.id) || { beats: [] };
    const beatIndex = (shot.beats || []).findIndex((b) => b.id === beat.id);
    const promptText = (p.beats[beatIndex] && p.beats[beatIndex].nano) || "";
    const imageModels = (MODELS && MODELS.image && MODELS.image.length) ? MODELS.image : FALLBACK_IMAGE_MODELS;
    if (!imageModels.find((m) => m.id === STILL_MODEL_ID)) STILL_MODEL_ID = imageModels[0].id;
    const selectedModel = imageModels.find((m) => m.id === STILL_MODEL_ID) || imageModels[0];

    box.append(Object.assign(el("div", "mini"), { textContent: "References auto-attached from this shot (omni-reference — feeds identity into the generation):" }));
    const chipRow = el("div", "row"); chipRow.style.cssText = "flex-wrap:wrap;margin:4px 0 8px;gap:4px";
    const refAssetsNow = (shot.refs || []).map((id) => (EP.assets || []).find((a) => a.id === id)).filter(Boolean);
    if (!refAssetsNow.length) chipRow.append(Object.assign(el("span", "mini"), { textContent: "none yet" }));
    refAssetsNow.forEach((a) => chipRow.append(Object.assign(el("span", "pill" + (a.path ? "" : " warn")), { textContent: `${a.name}${a.angle ? " · " + a.angle : ""}${a.path ? "" : " (no file — won't be sent as an image)"}` })));
    box.append(chipRow);

    const manageBtn = el("button", null, manageOpen ? "Hide references" : "Manage references");
    const manageHost = el("div"); manageHost.style.margin = "4px 0 8px";
    manageBtn.onclick = () => { manageOpen = !manageOpen; draw(); };
    box.append(manageBtn); box.append(manageHost);
    if (manageOpen) {
      manageHost.append(shotRefsPicker(shot, async (refs) => {
        shot.refs = refs;
        await post("/api/episode/shot/update", { dir: EP.dir, shotId: shot.id, patch: { refs } });
        PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`);
        draw();
      }));
    }

    // Editable, and exactly what "Generate still" sends — whichever model is
    // picked below. (The GPT-style wording is only a copy-paste handoff for
    // using ChatGPT by hand; the app never sends it.)
    const pb = p.beats[beatIndex] || {};
    box.append(promptBox("Prompt — sent to the model", "badge-nano", promptText, !!pb.nanoIsOverride, async (v) => {
      try {
        await post("/api/episode/beat/update", { dir: EP.dir, shotId: shot.id, beatId: beat.id, patch: { nanoOverride: v } });
        beat.nanoOverride = v;
        PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`);
        draw();
      } catch (e) { fail(e); }
    }));
    if (pb.gpt) {
      const cg = el("button", null, "Copy GPT-style version (for ChatGPT by hand)");
      cg.style.cssText = "padding:2px 8px;font-size:11px;margin:2px 0 4px";
      cg.onclick = () => { navigator.clipboard.writeText(pb.gpt); cg.textContent = "Copied"; setTimeout(() => { cg.textContent = "Copy GPT-style version (for ChatGPT by hand)"; }, 1200); };
      box.append(cg);
    }

    const modelRow = el("label", "f"); modelRow.style.margin = "6px 0";
    modelRow.append(el("span", null, "Model"));
    const modelSel = document.createElement("select");
    imageModels.forEach((m) => {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = `${m.label} ($${(m.usdPerImage ?? 0).toFixed(2)}/img${m.confidence === "uncalibrated" ? ", est." : ""})`;
      if (m.id === STILL_MODEL_ID) o.selected = true;
      modelSel.append(o);
    });
    modelSel.onchange = () => { STILL_MODEL_ID = modelSel.value; draw(); };
    modelRow.append(modelSel);
    box.append(modelRow);

    const status = el("div", "mini"); status.style.margin = "4px 0";
    const genBtn = el("button", "primary", `Generate still — ${selectedModel.label} ($${(selectedModel.usdPerImage ?? 0).toFixed(2)})`);
    genBtn.disabled = !promptText;
    genBtn.onclick = async () => {
      const label = genBtn.textContent;
      genBtn.disabled = true; genBtn.textContent = `Generating… (${waitHint(selectedModel.driver)})`;
      status.textContent = ""; status.style.color = "";
      try {
        await post("/api/episode/beat/generate-still", { dir: EP.dir, shotId: shot.id, beatId: beat.id, modelId: STILL_MODEL_ID });
        await reloadEpisode(shot.id);
      } catch (e) {
        genBtn.disabled = false; genBtn.textContent = label;
        status.textContent = e.message || String(e);
        status.style.color = "#e06a6a";
      }
    };
    box.append(genBtn);
    box.append(status);

    // Conversational follow-up, once there's something to follow up on — the
    // same move as typing a correction back to ChatGPT: the current still
    // goes back in as the anchor reference, the instruction says only what
    // should change. Never overwrites; each round lands as its own file.
    if (beat.frame && beat.frame.path) {
      const editBox = el("div"); editBox.style.cssText = "margin-top:10px;padding-top:10px;border-top:1px solid var(--line)";
      editBox.append(Object.assign(el("div", "mini"), { textContent: "Refine the current still (feeds the image above back in as the reference):" }));
      const editRow = el("div", "row"); editRow.style.margin = "4px 0";
      const editI = Object.assign(document.createElement("input"), { placeholder: "e.g. make the bird face into the room, entering" });
      editI.style.flex = "1";
      const editStatus = el("div", "mini"); editStatus.style.margin = "4px 0";
      const editBtn = el("button", "primary", `Revise — ${selectedModel.label} ($${(selectedModel.usdPerImage ?? 0).toFixed(2)})`);
      editBtn.onclick = async () => {
        const label = editBtn.textContent;
        if (!editI.value.trim()) { editStatus.textContent = "type what should change first"; editStatus.style.color = "#e06a6a"; return; }
        editBtn.disabled = true; editBtn.textContent = `Revising… (${waitHint(selectedModel.driver)})`;
        editStatus.textContent = ""; editStatus.style.color = "";
        try {
          await post("/api/episode/beat/refine-still", { dir: EP.dir, shotId: shot.id, beatId: beat.id, instruction: editI.value, modelId: STILL_MODEL_ID });
          await reloadEpisode(shot.id);
        } catch (e) {
          editBtn.disabled = false; editBtn.textContent = label;
          editStatus.textContent = e.message || String(e);
          editStatus.style.color = "#e06a6a";
        }
      };
      editRow.append(editI);
      editBox.append(editRow); editBox.append(editBtn); editBox.append(editStatus);
      box.append(editBox);
    }
  }

  draw();
  if (!MODELS || !MODELS.image || !MODELS.image.length) {
    api("/api/models").then((m) => { MODELS = m; draw(); }).catch(() => {});
  }
  return box;
}

// The shot's Identity Vault references, shown wherever a shot is worked on
// (each storyboard row and the video Generate pane) with a "Manage
// references" toggle. Shawn couldn't find the only picker (inside the
// still-generation panel of a frame with no image yet), 2026-10-10. The list
// belongs to the SHOT: storyboards and video both use it. `where` keeps the
// open state per place across the re-render that follows a change.
const OPEN_REF_MANAGERS = new Set();
function shotRefsSection(shot, where) {
  const key = `${where}:${shot.id}`;
  const wrap = el("div"); wrap.style.cssText = "margin:8px 0";
  const row = el("div", "row"); row.style.cssText = "flex-wrap:wrap;gap:4px;align-items:center";
  row.append(Object.assign(el("span", "mini"), { textContent: "References (whole shot):" }));
  const cur = (shot.refs || []).map((id) => (EP.assets || []).find((a) => a.id === id)).filter(Boolean)
    .sort((a, b) => (REF_TYPE_ORDER.indexOf(a.type) - REF_TYPE_ORDER.indexOf(b.type)) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  if (!cur.length) row.append(Object.assign(el("span", "pill warn"), { textContent: "none" }));
  cur.forEach((a) => row.append(Object.assign(el("span", "pill"), { textContent: `${a.name}${a.angle ? " · " + a.angle : ""}` })));
  const btn = el("button", null, OPEN_REF_MANAGERS.has(key) ? "Hide references" : "Manage references");
  btn.style.cssText = "font-size:11px;padding:2px 8px";
  btn.onclick = () => { if (OPEN_REF_MANAGERS.has(key)) OPEN_REF_MANAGERS.delete(key); else OPEN_REF_MANAGERS.add(key); withShotAnchor(shot.id, renderEpisode); };
  row.append(btn);
  wrap.append(row);
  if (OPEN_REF_MANAGERS.has(key)) {
    wrap.append(shotRefsPicker(shot, async (refs) => {
      try {
        await post("/api/episode/shot/update", { dir: EP.dir, shotId: shot.id, patch: { refs } });
        PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`);
        await reloadEpisode(shot.id);
      } catch (e) { fail(e); }
    }));
  }
  return wrap;
}

// A shot's references, laid out like the Identity Vault: grouped by type (characters,
// locations, props), alphabetical inside each, with a search box. A card with more than
// one image (a costume, an angle, close-ups) has a "Choose images" list: tick exactly the
// images this shot should send, so a night-clothes shot can send the night clothes
// without a duplicate upload. shot.refs holds the id of each image used.
const REF_TYPE_ORDER = ["character", "location", "prop"];
const REF_TYPE_TITLE = { character: "Characters", location: "Locations", prop: "Props" };
const OPEN_REF_CARDS = new Set(); // `${shotId}|${cardKey}` whose image list is open
let REF_FILTER = "";
function shotRefsPicker(shot, onChange) {
  const box = el("div", "card"); box.style.cssText = "background:var(--panel2);margin-top:4px;padding:8px";
  const groups = groupAssets(EP.assets || []);
  if (!groups.length) {
    box.append(Object.assign(el("div", "mini"), { textContent: "No assets in the Identity Vault yet." }));
  } else {
    const search = document.createElement("input");
    search.type = "search"; search.placeholder = "Find a character, location or prop…"; search.value = REF_FILTER;
    search.style.cssText = "width:100%;margin:0 0 8px;box-sizing:border-box";
    box.append(search);
    const cards = [];
    const sections = [];
    const byType = new Map();
    groups.forEach((g) => { const t = g[0].type; if (!byType.has(t)) byType.set(t, []); byType.get(t).push(g); });
    const types = [...REF_TYPE_ORDER.filter((t) => byType.has(t)), ...[...byType.keys()].filter((t) => !REF_TYPE_ORDER.includes(t)).sort()];
    types.forEach((t) => {
      const list = byType.get(t).sort((a, b) => a[0].name.localeCompare(b[0].name, undefined, { sensitivity: "base" }));
      const section = el("div"); section.style.margin = "6px 0";
      const head = Object.assign(el("div", "mini"), { textContent: `${(REF_TYPE_TITLE[t] || `${t[0].toUpperCase()}${t.slice(1)}s`).toUpperCase()} · ${list.length}` });
      head.style.cssText = "letter-spacing:.08em;margin:8px 0 4px;color:var(--muted, #8a93a6)";
      section.append(head);
      list.forEach((group) => {
        const card = refCard(shot, group, onChange);
        cards.push({ el: card, name: group[0].name.toLowerCase(), section });
        section.append(card);
      });
      sections.push(section);
      box.append(section);
    });
    const none = Object.assign(el("div", "mini"), { textContent: "Nothing in the vault matches that." }); none.style.display = "none";
    box.append(none);
    const applyFilter = () => {
      const q = search.value.trim().toLowerCase(); REF_FILTER = search.value;
      let shown = 0;
      cards.forEach((c) => { const hit = !q || c.name.includes(q); c.el.style.display = hit ? "" : "none"; if (hit) shown++; });
      sections.forEach((sec) => { sec.style.display = cards.some((c) => c.section === sec && c.el.style.display !== "none") ? "" : "none"; });
      none.style.display = shown ? "none" : "";
    };
    search.oninput = applyFilter;
    applyFilter();
  }

  // Automation misses references sometimes (a location it should have
  // attached but didn't). This is the escape hatch: pick any image — from
  // this project, the shared inbox, or a typed path — give it a name/type,
  // and it's added to the vault AND wired onto this shot in one step.
  const addRow = el("div"); addRow.style.marginTop = "8px";
  const addBtn = el("button", null, "+ Attach a new reference image");
  const addHost = el("div"); addHost.style.marginTop = "6px";
  addBtn.onclick = () => {
    if (addHost.children.length) { addHost.innerHTML = ""; return; }
    addHost.append(newReferenceFlow(shot, onChange));
  };
  addRow.append(addBtn); addRow.append(addHost);
  box.append(addRow);
  return box;
}

// One vault card in a shot's reference list: a toggle for the card, and for a card with
// several images a list to pick exactly which ones this shot sends.
function refCard(shot, group, onChange) {
  const main = group.find((a) => a.path) || group[0];
  const ids = group.map((a) => a.id);
  const refs = shot.refs || [];
  const picked = group.filter((a) => refs.includes(a.id));
  const on = picked.length > 0;
  const key = `${shot.id}|${main.type}:${main.name.trim().toLowerCase()}`;
  const withFiles = group.filter((a) => a.path);
  const wrap = el("div"); wrap.style.cssText = "margin:2px 0;padding:3px 6px;border-radius:8px;" + (on ? "background:rgba(210,60,70,.10);border:1px solid rgba(210,60,70,.35)" : "border:1px solid transparent");
  const row = el("div", "row"); row.style.cssText = "align-items:center;gap:8px;flex-wrap:nowrap";
  if (main.path) { const t = imageThumb(main.path, () => {}, { width: "34px", height: "34px" }); t.style.flexShrink = "0"; row.append(t); }
  const chip = el("button", "pill" + (on ? " on" : ""));
  chip.textContent = `${on ? "✓ " : ""}${main.name}${group.some((a) => a.path) ? "" : " (no file)"}`;
  chip.style.cssText = "cursor:pointer;margin:0";
  chip.title = on ? "Take this off the shot (every image of it)" : "Attach this to the shot (its main image; open the list to choose another)";
  chip.onclick = () => onChange(on ? refs.filter((id) => !ids.includes(id)) : [...refs, main.id]);
  row.append(chip);
  const sum = el("span", "mini"); sum.style.flex = "1";
  if (withFiles.length > 1) sum.textContent = on ? `${picked.length} of ${withFiles.length} images sent` : `${withFiles.length} images`;
  row.append(sum);
  if (withFiles.length > 1) {
    const open = OPEN_REF_CARDS.has(key);
    const tog = el("button", null, open ? "▴ Hide images" : "▾ Choose images");
    tog.style.cssText = "font-size:11px;padding:2px 8px";
    tog.title = "Pick exactly which images of this card the shot sends: a costume, an angle, close-ups";
    tog.onclick = () => { if (open) OPEN_REF_CARDS.delete(key); else OPEN_REF_CARDS.add(key); withShotAnchor(shot.id, renderEpisode); };
    row.append(tog);
  }
  wrap.append(row);
  if (withFiles.length > 1 && OPEN_REF_CARDS.has(key)) {
    const list = el("div"); list.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 2px 42px";
    withFiles.forEach((a) => {
      const sel = refs.includes(a.id);
      const cell = el("label"); cell.style.cssText = "display:flex;flex-direction:column;gap:3px;width:104px;cursor:pointer;font-size:11px";
      const t = imageThumb(a.path, () => {}, { width: "104px", height: "78px" });
      const line = el("div"); line.style.cssText = "display:flex;gap:5px;align-items:flex-start";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = sel; cb.style.marginTop = "2px";
      cb.onchange = () => onChange(cb.checked ? [...refs, a.id] : refs.filter((id) => id !== a.id));
      line.append(cb, Object.assign(el("span"), { textContent: a.angle || (a.id === main.id ? "Main image" : "Image"), style: "word-break:break-word" }));
      cell.append(t, line);
      list.append(cell);
    });
    wrap.append(list);
    wrap.append(Object.assign(el("div", "mini"), { textContent: "Tick only the images this shot should send. Unticking all of them takes the card off the shot.", style: "margin:4px 0 2px 42px" }));
  }
  return wrap;
}

// Pick an image via the wide picker, name it, and it becomes a real Identity
// Vault asset wired onto this shot — not a shot-only one-off, so the next
// shot that needs the same reference finds it already registered.
function newReferenceFlow(shot, onChange) {
  const wrap = el("div", "card"); wrap.style.cssText = "background:var(--panel3, #111826);padding:8px;margin-top:4px";
  wrap.append(Object.assign(el("div", "mini"), { textContent: "Pick an image, then name it:" }));

  const preview = el("div"); preview.style.margin = "6px 0";
  const form = el("div"); form.style.display = "none";
  const typeSel = document.createElement("select");
  ["character", "location", "prop"].forEach((t) => { const o = document.createElement("option"); o.value = t; o.textContent = t; typeSel.append(o); });
  const nameI = Object.assign(document.createElement("input"), { placeholder: "Name" });
  const saveBtn = el("button", "primary", "Add to vault + attach to shot");
  const status = el("div", "mini"); status.style.margin = "4px 0";
  const formGrid = el("div", "grid g2");
  formGrid.append(labeled("Type", typeSel), labeled("Name", nameI));
  form.append(formGrid, saveBtn, status);

  let pendingPath = null;
  const afterPick = (path_, name) => {
    pendingPath = null;
    preview.innerHTML = "";
    form.style.display = "none";
    const img = document.createElement("img");
    img.style.cssText = "max-width:160px;max-height:120px;object-fit:cover;border-radius:6px;display:block";
    img.onload = () => {
      pendingPath = path_;
      if (!nameI.value.trim()) nameI.value = (name || "").replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ");
      form.style.display = "";
    };
    img.onerror = () => {
      preview.innerHTML = "";
      preview.append(Object.assign(el("div", "mini"), { textContent: `Couldn't load an image at "${path_}".`, style: "color:#e06a6a" }));
    };
    img.src = mediaURL(path_, 200);
    preview.append(img);
  };

  wrap.append(imageSourcePicker({
    onPickInbox: async (file) => {
      try {
        const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
        const filename = `${Date.now()}_${slugify(file.name.replace(/\.[a-z0-9]+$/i, ""))}.${ext}`;
        const { path: newPath } = await post("/api/media/promote", { source: file.name, fromInbox: true, dir: EP.dir, destSub: "02_assets/misc", filename });
        afterPick(newPath, file.name);
      } catch (e) { fail(e); }
    },
    onPickDirect: (path_, name) => afterPick(path_, name),
    uploadDestSub: "02_assets/misc",
  }));
  wrap.append(preview);
  wrap.append(form);

  saveBtn.onclick = async () => {
    if (!pendingPath) { status.textContent = "pick an image first"; status.style.color = "#e06a6a"; return; }
    if (!nameI.value.trim()) { status.textContent = "give it a name"; status.style.color = "#e06a6a"; return; }
    saveBtn.disabled = true;
    try {
      const asset = await post("/api/episode/asset", { dir: EP.dir, asset: { type: typeSel.value, name: nameI.value.trim(), path: pendingPath, file: pendingPath.split("/").pop() } });
      EP.assets = EP.assets || [];
      EP.assets.push(asset);
      onChange([...(shot.refs || []), asset.id]);
    } catch (e) {
      saveBtn.disabled = false;
      status.textContent = e.message || String(e);
      status.style.color = "#e06a6a";
    }
  };

  return wrap;
}

// Tab 2: this episode's own 03_storyboard/, grouped by scene number (parsed
// off the frame filename's leading shot code) so it reads as a library, not
// a flat dump — this folder is already episode-scoped on disk, it just
// wasn't organized in the picker before.
function keyframeLibrary(files, onPick) {
  const wrap = el("div");
  if (!files.length) { wrap.append(Object.assign(el("div", "empty"), { textContent: "03_storyboard/ is empty — nothing generated for this episode yet." })); return wrap; }
  const byScene = new Map();
  files.forEach((f) => {
    const m = /^(\d+)/.exec(f.name);
    const scene = m ? String(Number(m[1])) : "other";
    if (!byScene.has(scene)) byScene.set(scene, []);
    byScene.get(scene).push(f);
  });
  const scenes = [...byScene.keys()].sort((a, b) => (a === "other" ? 1 : b === "other" ? -1 : Number(a) - Number(b)));
  scenes.forEach((scene) => {
    const group = el("details"); group.open = scenes.length <= 3;
    group.append(Object.assign(el("summary"), { textContent: scene === "other" ? `Ungrouped (${byScene.get(scene).length})` : `Scene ${scene} (${byScene.get(scene).length})` }));
    const grid = el("div", "assets"); grid.style.marginTop = "6px";
    byScene.get(scene).forEach((f) => {
      const cell = el("div", "asset"); cell.style.cursor = "pointer";
      if (f.kind === "image") {
        const img = document.createElement("img"); img.src = mediaURL(f.path, 200); img.style.cssText = "width:100%;height:80px;object-fit:cover;display:block";
        cell.append(img);
      } else {
        cell.append(Object.assign(el("div", "noimg"), { textContent: f.name }));
      }
      cell.append(Object.assign(el("div", "an mini"), { textContent: f.name }));
      cell.onclick = () => onPick(f.path);
      grid.append(cell);
    });
    group.append(grid);
    wrap.append(group);
  });
  return wrap;
}

// Tab 3: earlier work on this series. Shot numbers changed between versions,
// so nothing is matched by number — "Suggested" ranks by words the filename
// and folder share with this shot's label/description/location. The rest is
// grouped by folder with a filter box. Hover to enlarge, click to use.
const MATCH_STOP = new Set(["the", "and", "with", "from", "into", "her", "his", "its", "then", "int", "ext", "day", "night",
  "png", "jpg", "jpeg", "webp", "used", "start", "mid", "end", "shot", "scene", "insert", "est", "coverage", "one", "for", "she", "him"]);
const matchWords = (s) => new Set((s || "").toLowerCase().split(/[^a-z]+/)
  .filter((w) => w.length >= 3 && !MATCH_STOP.has(w)).map((w) => w.replace(/(ing|es|s)$/, "")));

function earlierPicker(files, shot, beat, onPick, emptyText = "No earlier stills found in this series folder.") {
  const wrap = el("div");
  if (!files.length) { wrap.append(Object.assign(el("div", "empty"), { textContent: emptyText })); return wrap; }
  const want = matchWords([shot.label, shot.action, shot.loc, shot.subjects, beat.desc].join(" "));
  const scored = files.map((f) => {
    const have = matchWords(`${f.folder} ${f.name}`);
    return { f, score: [...want].filter((w) => have.has(w)).length };
  });

  const cell = (f) => {
    const c = el("div", "asset"); c.style.cursor = "pointer";
    const t = imageThumb(f.path, () => onPick(f), { width: "100%", height: "80px" });
    t.title = `${f.folder}/${f.name}${f.also.length ? `\n(same image also at: ${f.also.join(", ")})` : ""}\nHover to enlarge, click to use for this still`;
    c.append(t);
    c.append(Object.assign(el("div", "an mini"), { textContent: f.name }));
    return c;
  };

  const suggested = scored.filter((x) => x.score >= 2).sort((a, b) => b.score - a.score).slice(0, 8);
  if (suggested.length) {
    wrap.append(Object.assign(el("div", "mini"), { textContent: "Suggested for this shot (by matching words — check by eye):", style: "margin-bottom:4px" }));
    const g = el("div", "assets"); suggested.forEach((x) => g.append(cell(x.f))); wrap.append(g);
  }

  const filterI = Object.assign(document.createElement("input"), { placeholder: "Filter by filename or folder…" });
  filterI.style.cssText = "margin:10px 0 6px;width:100%";
  wrap.append(filterI);
  const host = el("div"); wrap.append(host);
  const render = () => {
    host.innerHTML = "";
    const q = filterI.value.trim().toLowerCase();
    const byFolder = new Map();
    files.filter((f) => !q || `${f.folder}/${f.name}`.toLowerCase().includes(q)).forEach((f) => {
      if (!byFolder.has(f.folder)) byFolder.set(f.folder, []);
      byFolder.get(f.folder).push(f);
    });
    for (const [folder, list] of byFolder) {
      const group = el("details"); group.open = !!q;
      group.append(Object.assign(el("summary"), { textContent: `${folder} (${list.length})` }));
      const g = el("div", "assets"); g.style.marginTop = "6px";
      list.forEach((f) => g.append(cell(f)));
      group.append(g); host.append(group);
    }
    if (!byFolder.size) host.append(Object.assign(el("div", "mini"), { textContent: "No matches." }));
  };
  filterI.oninput = render;
  render();
  return wrap;
}

// Tab 4: the shared generated_imgs/ inbox — every project's raw output, so it
// gets a filter box instead of a bare 24-thumbnail dump.
function inboxPickerFiltered(onPick) {
  const wrap = el("div");
  const filterI = Object.assign(document.createElement("input"), { placeholder: "Filter by filename…" });
  filterI.style.cssText = "margin-bottom:6px;width:100%";
  wrap.append(filterI);
  const host = el("div"); wrap.append(host);
  let allFiles = null;
  const render = () => {
    host.innerHTML = "";
    const q = filterI.value.trim().toLowerCase();
    const files = (allFiles || []).filter((f) => !q || f.name.toLowerCase().includes(q));
    if (!files.length) { host.append(Object.assign(el("div", "empty"), { textContent: allFiles && allFiles.length ? "No files match that filter." : "generated_imgs/ is empty." })); return; }
    const grid = el("div", "assets");
    files.slice(0, 60).forEach((f) => {
      const cell = el("div", "asset"); cell.style.cursor = "pointer";
      const img = document.createElement("img");
      img.src = `/media-inbox?name=${encodeURIComponent(f.name)}&w=200`;
      img.style.cssText = "width:100%;height:80px;object-fit:cover;display:block";
      cell.append(img);
      cell.append(Object.assign(el("div", "an mini"), { textContent: f.name }));
      cell.onclick = () => onPick(f);
      grid.append(cell);
    });
    host.append(grid);
  };
  filterI.oninput = render;
  host.innerHTML = "Loading…";
  api("/api/generated/list").then((r) => { allFiles = r.files; render(); }).catch((e) => { host.innerHTML = ""; fail(e); });
  return wrap;
}

// ---------------- production: fan-out console + version tray ----------------

let MODELS = null;
let FANOUT_SEL = { models: new Set(), shots: new Set(), seconds: null, driver: "fal" };
let VERSIONS_TIMER = null;

function productionPanel() {
  const c = el("div", "card");
  const hr = el("div", "row");
  hr.append(Object.assign(el("h2"), { textContent: "Production — generate", style: "flex:1" }));
  c.append(hr);
  c.append(Object.assign(el("div"), { id: "prodBody" }));
  loadProduction(c);
  return c;
}

// `poll` = a background refresh while a take is generating. Those must not
// touch the page unless something actually changed, and never blank it: the
// old version cleared the panel to "Loading…" every 5s, collapsing and
// regrowing everything above the Shots list — the page stuttered and jumped
// the whole time a clip was generating.
let VERSIONS_SIG = null;
const versionsSig = (data) => JSON.stringify(data.versions.map((v) => [v.id, v.state, v.path, v.selected, v.modelLabel]));

// ---------- Claude helpers (server/llm.js): suggestions, paid per call ----------
//
// Rough token sizes per call, for the price shown before Shawn clicks: a
// prompt draft sends the guide + two storyboard images + the shot (~5.5k in)
// and writes a short prompt after medium-effort thinking (~2k out); a scene
// breakdown sends the scene's script plus the previous scene (~3k in) and
// writes its shots (~2.5k out; the old 5.5k guess quoted ~4x the real cost).
// The real cost comes from the response's usage and lands in the ledger.
// Token estimates per call, calibrated 2026-10-12 from real runs on Opus 5.5:
// prompt draft $0.045 (5b); scene breakdowns $0.03–0.085 (now with the
// previous scene as context); a vault hold draft $0.027 (image + bible).
const LLM_EST = { prompt: { in: 5500, out: 2000 }, shots: { in: 3000, out: 2500 }, asset: { in: 4000, out: 600 } };
let LLM = null;
// Claude's kept suggestions live on the episode (EP.claude), so they survive
// a reload and show however they were run.
const claudeDraft = (shotId) => ((EP.claude || {}).drafts || {})[shotId] || null;
const sceneIdOf = (g) => ((EP.scenes || []).find((x) => String(x.number) === String(g.num)) || {}).id;
const claudeAssetDraft = (kind, assetId) => ((EP.claude || {}).assets || {})[`${kind}:${assetId}`] || null;
const claudeProposal = (g) => ((EP.claude || {}).proposals || {})[sceneIdOf(g)] || null;
const claudeClear = (kind, key) => post("/api/episode/claude/clear", { dir: EP.dir, kind, key }).then(() => {
  if (EP.claude && EP.claude[kind]) delete EP.claude[kind][key];
});
async function llmInfo() { if (!LLM) LLM = await api("/api/llm"); return LLM; }
const llmEstimate = (m, task) => (LLM_EST[task].in * m.inPerM + LLM_EST[task].out * m.outPerM) / 1e6;
function llmModelSelect(task) {
  const s = document.createElement("select"); s.style.cssText = "width:auto;font-size:12px";
  (LLM ? LLM.models : []).forEach((m) => {
    const o = document.createElement("option"); o.value = m.id;
    o.textContent = `${m.label} (~$${llmEstimate(m, task).toFixed(llmEstimate(m, task) < 0.01 ? 3 : 2)} a ${task === "prompt" ? "draft" : "scene"})`;
    if (m.id === (localPick(`llm-${task}`) || LLM.default)) o.selected = true;
    s.append(o);
  });
  s.onchange = () => { try { localStorage.setItem(`rcs-llm-${task}`, s.value); } catch { /* per-viewer convenience only */ } };
  return s;
}
function localPick(k) { try { return localStorage.getItem(`rcs-${k}`); } catch { return null; } }

// In the Generate pane: Claude writes this shot's prompt for the chosen video
// model. Nothing is saved until "Use this prompt".
function claudePromptTool(shot, sel) {
  const det = el("details"); det.style.cssText = "margin:4px 0 8px;padding:6px 8px;border:1px solid var(--line);border-radius:8px";
  const draft = claudeDraft(shot.id);
  det.open = !!draft;
  det.append(Object.assign(el("summary"), { textContent: "Draft this prompt with Claude…", style: "cursor:pointer;font-size:12px;font-weight:600" }));
  const body = el("div"); body.style.cssText = "display:flex;flex-direction:column;gap:6px;margin-top:6px";
  det.append(body);
  det.ontoggle = async () => {
    if (!det.open || body.dataset.ready) return;
    body.dataset.ready = "1";
    try { await llmInfo(); } catch (e) { fail(e); return; }
    if (!LLM.ready) { body.append(Object.assign(el("div", "mini warn"), { textContent: LLM.reason })); return; }
    body.append(Object.assign(el("div", "mini"), { textContent: "Claude reads this shot's fields, its start/end storyboards and the guide for the selected video model, and writes the prompt. It's a suggestion: nothing is saved until you click Use this prompt." }));
    const intent = Object.assign(document.createElement("textarea"), { rows: 2, placeholder: "Optional: what should happen, in your words (e.g. \"Flame pulls the door toward herself; Overlock is tired, not hostile\")" });
    intent.style.cssText = "font-size:12px";
    const row = el("div"); row.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap";
    const msel = llmModelSelect("prompt");
    const go = el("button", "primary", "Draft prompt");
    const status = el("span", "mini");
    row.append(msel, go, status);
    body.append(intent, row);
    const out = el("div"); body.append(out);
    const show = (r) => {
      out.replaceChildren();
      if (!r) return;
      const ta = Object.assign(document.createElement("textarea"), { value: r.prompt, rows: 6 });
      ta.style.cssText = "width:100%;font-size:12px";
      out.append(ta);
      (r.notes || []).forEach((n) => out.append(Object.assign(el("div", "mini"), { textContent: `• ${n}` })));
      out.append(Object.assign(el("div", "mini"), { textContent: `${r.model} · $${Number(r.usd).toFixed(4)} (in the ledger)` }));
      const use = el("button", "primary", "Use this prompt");
      use.title = "Save it as this shot's hand-edited prompt (Undo brings back the previous one)";
      use.onclick = async () => {
        try {
          await post("/api/episode/shot/update", { dir: EP.dir, shotId: shot.id, patch: { videoPromptOverride: ta.value.trim(), videoPromptMode: null } });
          await claudeClear("drafts", shot.id);
          flashNote("Prompt saved on the shot");
          await refreshPrompts(shot.id);
        } catch (e) { fail(e); }
      };
      const drop = el("button", null, "Discard");
      drop.onclick = () => claudeClear("drafts", shot.id).then(() => show(null)).catch(fail);
      const btns = el("div"); btns.style.cssText = "display:flex;gap:6px;margin-top:4px"; btns.append(use, drop);
      out.append(btns);
    };
    show(claudeDraft(shot.id));
    go.onclick = async () => {
      go.disabled = true; status.textContent = "Claude is writing… (10–40 s)";
      try {
        const r = await post("/api/episode/claude/prompt", { dir: EP.dir, shotId: shot.id, videoModelId: sel.modelId, seconds: sel.seconds, llm: msel.value, intent: intent.value.trim() });
        EP.claude = EP.claude || { drafts: {}, proposals: {} };
        (EP.claude.drafts = EP.claude.drafts || {})[shot.id] = r;
        status.textContent = "";
        show(r);
      } catch (e) { status.textContent = ""; fail(e); }
      finally { go.disabled = false; }
    };
  };
  if (det.open) setTimeout(() => det.ontoggle(), 0);
  return det;
}

// Under each scene heading in Shots: Claude proposes a shot list from the
// scene's script; tick the ones to add. Nothing changes until "Add".
function claudeShotsTool(g) {
  const det = el("details"); det.style.cssText = "margin:2px 0 8px;font-size:12px";
  const saved = claudeProposal(g);
  // Stays closed until you open it; a saved proposal is flagged on the summary line instead of forcing the panel open.
  det.append(Object.assign(el("summary"), { textContent: saved ? "Propose shots for this scene with Claude… (a saved proposal is waiting)" : "Propose shots for this scene with Claude…", style: "cursor:pointer;color:var(--dim)" }));
  const body = el("div"); body.style.cssText = "display:flex;flex-direction:column;gap:6px;margin:6px 0;padding:8px;border:1px solid var(--line);border-radius:8px";
  det.append(body);
  det.ontoggle = async () => {
    if (!det.open || body.dataset.ready) return;
    body.dataset.ready = "1";
    try { await llmInfo(); } catch (e) { fail(e); return; }
    if (!LLM.ready) { body.append(Object.assign(el("div", "mini warn"), { textContent: LLM.reason })); return; }
    body.append(Object.assign(el("div", "mini"), { textContent: "Claude reads this scene in your script and proposes a shot list for AI video (one action per shot, risks flagged). Tick the shots you want; they're added at the end of the scene. Your existing shots are never changed." }));
    const intent = Object.assign(document.createElement("textarea"), { rows: 2, placeholder: "Optional: how you see the scene (pace, coverage, what matters most)" });
    intent.style.cssText = "font-size:12px";
    const row = el("div"); row.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap";
    const msel = llmModelSelect("shots");
    const go = el("button", "primary", "Propose shots");
    const status = el("span", "mini");
    row.append(msel, go, status);
    body.append(intent, row);
    const out = el("div"); body.append(out);
    const show = (r) => {
      out.replaceChildren();
      if (!r) return;
      const ticks = [];
      r.shots.forEach((p, i) => {
        const line = el("label"); line.style.cssText = "display:flex;gap:8px;align-items:flex-start;padding:4px 0;border-top:1px solid var(--line)";
        const cb = Object.assign(document.createElement("input"), { type: "checkbox", checked: !p.matches_existing });
        ticks.push(cb);
        const t = el("div");
        t.append(Object.assign(el("div"), { textContent: `${i + 1}. ${p.label}  ·  ${p.size} ${p.angle} ${p.move}  ·  ${p.seconds} s${p.matches_existing ? `  ·  like your ${p.matches_existing}` : ""}`, style: "font-weight:600" }));
        t.append(Object.assign(el("div", "mini"), { textContent: p.action }));
        (p.dialogue || []).forEach((d) => t.append(Object.assign(el("div", "mini"), { textContent: `${d.character}${d.delivery ? ` (${d.delivery})` : ""}: "${d.line}"` })));
        if (p.sound) t.append(Object.assign(el("div", "mini"), { textContent: `Sound: ${p.sound}` }));
        if (p.risk) t.append(Object.assign(el("div", "mini warn"), { textContent: `Risk: ${p.risk}` }));
        line.append(cb, t);
        out.append(line);
      });
      (r.notes || []).forEach((n) => out.append(Object.assign(el("div", "mini"), { textContent: `• ${n}`, style: "margin-top:4px" })));
      out.append(Object.assign(el("div", "mini"), { textContent: `${r.model} · $${Number(r.usd).toFixed(4)} (in the ledger). Shots already like yours start unticked.`, style: "margin-top:4px" }));
      const add = el("button", "primary", "Add ticked shots to this scene");
      add.onclick = async () => {
        const picked = r.shots.filter((_, i) => ticks[i].checked);
        if (!picked.length) { fail(new Error("Tick at least one shot first.")); return; }
        try {
          await post("/api/episode/claude/shots/add", { dir: EP.dir, sceneNum: g.num, shots: picked });
          await claudeClear("proposals", sceneIdOf(g));
          flashNote(`Added ${picked.length} shot${picked.length === 1 ? "" : "s"} to scene ${g.num} (Undo removes them)`);
          await reloadEpisode();
        } catch (e) { fail(e); }
      };
      const drop = el("button", null, "Discard");
      drop.onclick = () => claudeClear("proposals", sceneIdOf(g)).then(() => show(null)).catch(fail);
      const btns = el("div"); btns.style.cssText = "display:flex;gap:6px;margin-top:6px"; btns.append(add, drop);
      out.append(btns);
    };
    show(claudeProposal(g));
    go.onclick = async () => {
      go.disabled = true; status.textContent = "Claude is reading the scene… (20–90 s)";
      try {
        const r = await post("/api/episode/claude/shots", { dir: EP.dir, sceneNum: g.num, llm: msel.value, intent: intent.value.trim() });
        EP.claude = EP.claude || { drafts: {}, proposals: {} };
        (EP.claude.proposals = EP.claude.proposals || {})[sceneIdOf(g)] = r;
        status.textContent = "";
        show(r);
      } catch (e) { status.textContent = ""; fail(e); }
      finally { go.disabled = false; }
    };
  };
  if (det.open) setTimeout(() => det.ontoggle(), 0);
  return det;
}

// Episode-wide starting model for every shot's Generate pane. A shot whose
// model was picked by hand keeps its own pick.
function defaultVideoModelRow() {
  const videoModels = (MODELS && MODELS.video) || [];
  const row = el("div"); row.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0";
  row.append(Object.assign(el("span"), { textContent: "Default video model", style: "font-size:12px;font-weight:600" }));
  const cur = videoModelFor({}, EP, videoModels.map((m) => m.id));
  const sel = videoModels.length ? videoModelPicker(videoModels, cur, async (id) => {
    try {
      await post("/api/episode/video-model", { dir: EP.dir, modelId: id });
      VIDEO_GEN_SEL.clear();
      PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`);
      await reloadEpisode(currentAnchorShotId());
    } catch (e) { fail(e); }
  }) : el("span", "mini", "Loading models…");
  const own = (EP.shots || []).filter((s) => s.videoModelId && s.videoModelId !== cur).length;
  row.append(sel, Object.assign(el("span", "mini"), {
    textContent: `Each shot's Generate pane starts here.${own ? ` ${own} shot${own === 1 ? " has its" : "s have their"} own pick and keep${own === 1 ? "s" : ""} it.` : ""} Choosing a model costs nothing.`,
  }));
  return row;
}

async function loadProduction(card, { poll = false } = {}) {
  const host = card.querySelector("#prodBody");
  if (!poll && !host.children.length) host.innerHTML = '<div class="mini">Loading…</div>';
  try {
    if (!MODELS) MODELS = await api("/api/models");
    const data = await api(`/api/episode/versions?dir=${encodeURIComponent(EP.dir)}`);
    const sig = versionsSig(data);
    const prev = VERSIONS_SIG;
    VERSIONS_SIG = sig;
    if (poll && sig === prev) { scheduleVersionRefresh(card, data); return; }

    // A take finished or failed: refresh the whole episode so the shot's own
    // take list (in the Shots panel) shows it too — anchored on whichever
    // shot is currently in view (currentAnchorShotId), not a blind scrollY
    // restore. This poll fires in the BACKGROUND, seconds after whatever
    // triggered it — a blind restore breaks the instant anything above the
    // viewport changes height in the meantime (the Storyboard/Gates panels
    // both can, e.g. an approval count), which read as "clicking Generate
    // jumps me to Storyboard" even though the click itself was long done.
    if (poll && prev) {
      await reloadEpisode(currentAnchorShotId());
      return;
    }

    const frag = document.createDocumentFragment();
    frag.append(ledgerBar(data.ledger, card), defaultVideoModelRow(), fanOutConsole(card, data.ledger), versionTray(data, card));
    host.replaceChildren(frag);
    scheduleVersionRefresh(card, data);
  } catch (e) { if (!poll) host.innerHTML = ""; fail(e); }
}

// Poll only while something is actually in flight — no background chatter on a
// desk that's just sitting open.
function scheduleVersionRefresh(card, data) {
  clearTimeout(VERSIONS_TIMER);
  const busy = data.versions.some((v) => v.state === "queued" || v.state === "running");
  if (!busy) return;
  VERSIONS_TIMER = setTimeout(() => {
    if (document.body.contains(card)) loadProduction(card, { poll: true });
  }, 5000);
}

function ledgerBar(led, card) {
  const box = el("div", "card"); box.style.cssText = "background:var(--panel2);margin:0 0 10px";
  const row = el("div", "row");
  const pct = led.budgetCapUSD ? Math.min(100, (led.committedUSD / led.budgetCapUSD) * 100) : 0;
  row.append(Object.assign(el("div"), { textContent: "Budget", style: "font-weight:600" }));
  row.append(Object.assign(el("span", "pill" + (pct > 80 ? " warn" : " ok")), { textContent: `$${led.committedUSD.toFixed(2)} of $${led.budgetCapUSD.toFixed(2)}` }));
  if (led.inFlightUSD > 0) row.append(Object.assign(el("span", "pill warn"), { textContent: `$${led.inFlightUSD.toFixed(2)} in flight` }));
  row.append(Object.assign(el("span", "mini"), { textContent: `$${led.remainingUSD.toFixed(2)} left · confirm above $${led.confirmAboveUSD.toFixed(2)}`, style: "flex:1" }));
  const edit = el("button", null, "Limits");
  edit.onclick = () => {
    const cap = prompt("Per-episode budget cap (USD):", String(led.budgetCapUSD));
    if (cap == null) return;
    const conf = prompt("Require confirmation above (USD):", String(led.confirmAboveUSD));
    if (conf == null) return;
    post("/api/episode/ledger/settings", { dir: EP.dir, budgetCapUSD: Number(cap), confirmAboveUSD: Number(conf) })
      .then(() => loadProduction(card)).catch(fail);
  };
  row.append(edit);
  box.append(row);

  const bar = el("div"); bar.style.cssText = "height:5px;border-radius:3px;background:#0f131a;margin-top:8px;overflow:hidden";
  const fill = el("div"); fill.style.cssText = `height:100%;width:${pct}%;background:${pct > 80 ? "var(--warn)" : "var(--clover)"}`;
  bar.append(fill); box.append(bar);
  return box;
}

function fanOutConsole(card, led) {
  const box = el("div", "card"); box.style.cssText = "background:var(--panel2);margin:0 0 10px";
  box.append(Object.assign(el("h3"), { textContent: "Fan-out", style: "font-size:13px;margin-bottom:4px" }));
  box.append(Object.assign(el("div", "mini"), { textContent: "One approved keyframe, several models at once, compared side by side. Only shots with an APPROVED board frame AND a chosen camera move can be generated — enforced server-side." }));

  // shots eligible = those with an approved keyframe still AND a chosen move
  const boarded = (EP.shots || []).filter((s) => (s.beats || []).some((b) => b.keyframe && b.frame && b.frame.approved));
  const eligible = boarded.filter((s) => s.move && s.move.trim());
  if (!eligible.length) {
    box.append(Object.assign(el("div", "empty"), {
      textContent: boarded.length
        ? `${boarded.length} boarded shot${boarded.length === 1 ? "" : "s"} still need${boarded.length === 1 ? "s" : ""} a camera move chosen (Move field, Shots list) before they're eligible.`
        : "No shot has an approved board frame yet. Approve one in the Storyboard panel first.",
    }));
    return box;
  }

  box.append(Object.assign(el("div", "mini"), { textContent: "Shots", style: "margin-top:10px" }));
  const shotRow = el("div", "row");
  eligible.forEach((s) => {
    const code = `${s.sceneNum}${s.shotCode}`;
    const chip = el("button", "pill" + (FANOUT_SEL.shots.has(s.id) ? " on" : ""));
    chip.textContent = code;
    chip.onclick = () => { FANOUT_SEL.shots.has(s.id) ? FANOUT_SEL.shots.delete(s.id) : FANOUT_SEL.shots.add(s.id); loadProduction(card); };
    shotRow.append(chip);
  });
  box.append(shotRow);

  box.append(Object.assign(el("div", "mini"), { textContent: "Models", style: "margin-top:10px" }));
  // Grouped by model family (Shawn, 2026-10-12): one line per family, a chip
  // per mode / tier / quality / service, price on each chip.
  const modelRow = el("div"); modelRow.style.cssText = "display:flex;flex-direction:column;gap:6px";
  PICK_FAMILIES.forEach(([fid, flabel]) => {
    const rows = MODELS.video.filter((m) => m.family === fid)
      .sort((a, b) => (a.mode > b.mode ? 1 : a.mode < b.mode ? -1 : 0) || String(a.tier).localeCompare(String(b.tier)) || PICK_RES_ORDER.indexOf(a.res) - PICK_RES_ORDER.indexOf(b.res) || (a.via === "fal" ? 0 : 1) - (b.via === "fal" ? 0 : 1));
    if (!rows.length) return;
    const line = el("div", "row"); line.style.cssText = "flex-wrap:wrap;gap:4px;align-items:center";
    line.append(Object.assign(el("span", "mini"), { textContent: flabel, style: "min-width:120px;font-weight:600" }));
    rows.forEach((m) => {
      const parts = [m.mode === "refs" ? "refs" : "", m.tier && fid === "sd20" ? m.tier : "", m.res || "", (m.via || "fal") !== "fal" ? m.via : ""].filter(Boolean).join(" · ") || "default";
      const chip = el("button", "pill" + (FANOUT_SEL.models.has(m.id) ? " on" : ""));
      chip.textContent = `${parts} ${pickEst(m)}${pickMoney(m)}`;
      chip.title = `${m.label} — ${m.note || ""} (rate: ${m.confidence})`;
      chip.onclick = () => { FANOUT_SEL.models.has(m.id) ? FANOUT_SEL.models.delete(m.id) : FANOUT_SEL.models.add(m.id); loadProduction(card); };
      line.append(chip);
    });
    modelRow.append(line);
  });
  box.append(modelRow);

  const ctl = el("div", "row"); ctl.style.marginTop = "10px";
  const secSel = document.createElement("select");
  // The union of every video model's own duration menu (not a hardcoded
  // [5, 10] — that's exactly the bug Shawn hit: MiniMax H3 alone actually
  // sells 5-15s, Seedance/Wan up to 30s, and this dropdown offered neither).
  // A duration a currently-checked model doesn't sell exactly still resolves
  // safely — billableSeconds() (server/jobs.js) snaps it up to that model's
  // own nearest sellable tier, or errors that clip specifically; it never
  // silently mis-prices.
  const fanoutDurations = Array.from(new Set((MODELS.video || []).flatMap((m) => m.durations || [5, 10]))).sort((a, b) => a - b);
  // A remaster episode defaults to each shot's own target length from the
  // Resolve cut (server snaps it up to what each model sells).
  if (EP.remaster && FANOUT_SEL.seconds == null) FANOUT_SEL.seconds = "target";
  if (EP.remaster) {
    const o = document.createElement("option"); o.value = "target"; o.textContent = "Each shot's target";
    if (FANOUT_SEL.seconds === "target") o.selected = true; secSel.append(o);
  }
  fanoutDurations.forEach((n) => { const o = document.createElement("option"); o.value = n; o.textContent = `${n}s`; if (FANOUT_SEL.seconds === n) o.selected = true; secSel.append(o); });
  secSel.onchange = () => { FANOUT_SEL.seconds = secSel.value === "target" ? "target" : Number(secSel.value); loadProduction(card); };
  secSel.style.width = EP.remaster ? "150px" : "80px";
  ctl.append(Object.assign(el("span", "mini"), { textContent: "Duration" }), secSel);
  const drvSel = document.createElement("select");
  ["fal", "mock"].forEach((d) => {
    const o = document.createElement("option"); o.value = d;
    const st = MODELS.drivers[d];
    o.textContent = `${d}${st && !st.ready ? " (not ready)" : ""}`;
    if (FANOUT_SEL.driver === d) o.selected = true;
    drvSel.append(o);
  });
  drvSel.onchange = () => { FANOUT_SEL.driver = drvSel.value; loadProduction(card); };
  drvSel.style.width = "140px";
  ctl.append(Object.assign(el("span", "mini"), { textContent: "Driver" }), drvSel);
  if (FANOUT_SEL.driver === "mock") {
    ctl.append(Object.assign(el("span", "pill ok"), { textContent: "mock — no spend" }));
  }
  // Sound switch: only shown when a picked model has one (Atlas and Comfy Seedance rows).
  const soundModels = [...FANOUT_SEL.models].map((id) => (MODELS.video || []).find((m) => m.id === id)).filter((m) => m && m.audioSwitch);
  if (soundModels.length) {
    ctl.append(Object.assign(el("span", "mini"), { textContent: "Sound" }));
    [["On", true], ["Off", false]].forEach(([label, val]) => {
      const b = el("button", "rc-chip" + ((FANOUT_SEL.audio !== false) === val ? " on" : ""), label);
      b.title = val ? "The model generates sound: effects, ambience and speech" : "Silent takes. Same price. Applies to the models that have a sound switch";
      b.onclick = () => { FANOUT_SEL.audio = val; loadProduction(card); };
      ctl.append(b);
    });
  }
  box.append(ctl);

  box.append(Object.assign(el("div"), { id: "quoteBox", style: "margin-top:10px" }));
  refreshQuote(box, card, led);
  return box;
}

// Live quote. The figure shown here is echoed back on submit and re-checked
// server-side, so what the human confirms is what gets enforced.
async function refreshQuote(box, card, led) {
  const host = box.querySelector("#quoteBox");
  const shotIds = [...FANOUT_SEL.shots], modelIds = [...FANOUT_SEL.models];
  const soundModels = modelIds.map((id) => (MODELS.video || []).find((m) => m.id === id)).filter((m) => m && m.audioSwitch);
  if (!shotIds.length || !modelIds.length) {
    host.innerHTML = '<div class="mini">Pick at least one shot and one model.</div>';
    return;
  }
  try {
    const q = await post("/api/episode/quote", { dir: EP.dir, shotIds, modelIds, seconds: FANOUT_SEL.seconds });
    host.innerHTML = "";
    const row = el("div", "row");
    row.append(Object.assign(el("div"), { textContent: `${q.clips} clip${q.clips === 1 ? "" : "s"}`, style: "font-weight:600" }));
    row.append(Object.assign(el("span", "pill" + (q.fitsInBudget ? "" : " warn")), { textContent: `est. $${q.totalUSD.toFixed(2)}` }));
    if (!q.fitsInBudget) row.append(Object.assign(el("span", "pill warn"), { textContent: `over budget — $${q.ledger.remainingUSD.toFixed(2)} left` }));
    if (q.needsConfirmation && q.fitsInBudget) row.append(Object.assign(el("span", "pill warn"), { textContent: "needs confirmation" }));
    host.append(row);
    const rn = routeNote(q); if (rn) host.append(rn);

    if (q.uncalibrated.length) {
      host.append(Object.assign(el("div", "mini"), {
        textContent: `Estimate only — ${q.uncalibrated.join(", ")} ${q.uncalibrated.length === 1 ? "bills" : "bill"} in units the service can't quote before a run, so ${q.uncalibrated.length === 1 ? "this is a deliberately high ceiling, not a price" : "these are deliberately high ceilings, not prices"}.`,
        style: "color:var(--warn);margin-top:4px",
      }));
    }

    const go = el("button", "primary", `Generate ${q.clips} clip${q.clips === 1 ? "" : "s"} · $${q.totalUSD.toFixed(2)}`);
    go.disabled = !q.fitsInBudget;
    go.style.marginTop = "8px";
    go.onclick = async () => {
      if (q.needsConfirmation) {
        const ok = confirm(
          `Generate ${q.clips} clip(s) on ${modelIds.length} model(s)?\n\n` +
          `Estimated cost: $${q.totalUSD.toFixed(2)}\n` +
          `Driver: ${FANOUT_SEL.driver}${FANOUT_SEL.driver === "mock" ? " (no real spend)" : ""}\n` +
          `Budget left after: $${(q.ledger.remainingUSD - q.totalUSD).toFixed(2)}\n\n` +
          (q.uncalibrated.length ? `Note: ${q.uncalibrated.join(", ")} price is an estimate, not a quote.\n\n` : "") +
          `Proceed?`,
        );
        if (!ok) return;
      }
      go.disabled = true; go.textContent = "Submitting…";
      try {
        await post("/api/episode/fanout", {
          dir: EP.dir, shotIds, modelIds, seconds: FANOUT_SEL.seconds,
          driver: FANOUT_SEL.driver,
          confirmedUSD: q.totalUSD,   // the exact figure shown above
          ...(FANOUT_SEL.audio === false && soundModels.length ? { audio: false } : {}),
        });
        await loadProduction(card);
      } catch (e) { fail(e); go.disabled = false; }
    };
    host.append(go);
  } catch (e) { host.innerHTML = ""; fail(e); }
}

function versionTray(data, card) {
  const box = el("div", "card"); box.style.cssText = "background:var(--panel2);margin:0";
  const hr = el("div", "row");
  hr.append(Object.assign(el("h3"), { textContent: "Version tray", style: "font-size:13px;flex:1" }));
  if (data.queue.running || data.queue.pending) {
    hr.append(Object.assign(el("span", "pill warn"), { textContent: `${data.queue.running} running · ${data.queue.pending} queued` }));
  }
  const stale = data.versions
    .map((v) => ({ v, after: stripStaleLabelPrefix(v.modelLabel) }))
    .filter(({ v, after }) => after !== v.modelLabel);
  if (stale.length) {
    const cleanBtn = el("button", null, `Clean up ${stale.length} carryover label${stale.length === 1 ? "" : "s"}`);
    cleanBtn.title = "Strip baked-in shot codes like \"2c - \" — they go stale the moment a shot moves or renumbers";
    cleanBtn.onclick = async () => {
      const preview = stale.slice(0, 8).map(({ v, after }) => `  "${v.modelLabel}"\n  → "${after}"`).join("\n\n");
      const more = stale.length > 8 ? `\n\n…and ${stale.length - 8} more.` : "";
      if (!confirm(`Strip the stale shot-code prefix from ${stale.length} take label${stale.length === 1 ? "" : "s"}?\n\n${preview}${more}\n\nOne undo step for the whole batch.`)) return;
      try {
        await post("/api/episode/versions/relabel-bulk", { dir: EP.dir, updates: stale.map(({ v, after }) => ({ versionId: v.id, modelLabel: after })) });
        await loadProduction(card);
      } catch (e) { fail(e); }
    };
    hr.append(cleanBtn);
  }
  box.append(hr);

  if (!data.versions.length) {
    box.append(Object.assign(el("div", "empty"), { textContent: "No takes yet." }));
    return box;
  }

  const byShot = new Map();
  data.versions.forEach((v) => {
    if (!byShot.has(v.shotCode)) byShot.set(v.shotCode, []);
    byShot.get(v.shotCode).push(v);
  });

  // Rows arrive in ep.shots order (server route), which is already scene
  // order — a scene heading (same component + anchor scheme as the Storyboard
  // and Shots panels) drops in wherever the scene number changes, so the
  // sidebar's per-section scene links have somewhere to land here too.
  const groupsByNum = new Map(sceneGroups().map((g) => [g.num, g]));
  let lastScene = null;
  for (const [code, versions] of byShot) {
    const sn = String(versions[0].sceneNum ?? "");
    if (sn !== lastScene) {
      const g = groupsByNum.get(sn);
      if (g) box.append(sceneHeader(g, "prod"));
      lastScene = sn;
    }
    const grp = el("div"); grp.style.marginTop = "8px";
    grp.append(Object.assign(el("div", "mini"), { textContent: `${code} — ${versions[0].shotLabel || ""}` }));
    versions.forEach((v) => grp.append(versionRow(v)));
    box.append(grp);
  }
  return box;
}

// The "Lip sync…" form under a take. Picks one of the SHOT's imported dialogue
// clips, a model and a sync mode, shows the exact price from the same server
// quote the spend guards use, and always confirms before spending.
function lipsyncPanel(v, onClose) {
  const box = el("div"); box.style.cssText = "margin:6px 0 4px 6px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel)";
  const shot = EP.shots.find((s) => s.id === v.shotId);
  const clips = (shot && shot.audioClips) || [];
  if (!clips.length) {
    box.append(Object.assign(el("div", "mini"), { textContent: "No dialogue audio on this shot yet. Add a recorded line first: Shots → this shot → Generate video → Dialogue audio." }));
    return box;
  }
  const mk = (opts) => { const s = document.createElement("select"); opts.forEach(([val, txt]) => { const o = document.createElement("option"); o.value = val; o.textContent = txt; s.append(o); }); return s; };
  const audioSel = mk(clips.map((c) => [c.id, `${c.label} (${c.seconds}s)`]));
  const modelSel = mk((GRAMMAR.lipsyncModels || []).map((m) => [m.id, `${m.label} — $${(m.usdPerVideoSecond * 60).toFixed(0)}/min`]));
  const modeSel = mk((GRAMMAR.lipsyncSyncModes || ["cut_off"]).map((m) => [m, m]));
  modeSel.title = "What to do when the audio and the take differ in length (sync.so's own modes)";
  const driverSel = mk([["fal", "fal (paid)"], ["mock", "mock (free rehearsal)"]]);
  const g = el("div", "grid g2");
  g.append(labeled("Audio line", audioSel), labeled("Model", modelSel), labeled("If lengths differ", modeSel), labeled("Service", driverSel));
  box.append(g);

  const info = el("div", "mini"); info.style.margin = "6px 0";
  box.append(info);
  let quoted = null;
  const go = el("button", "primary", "Run lip sync");
  const cancel = el("button", null, "Close");
  cancel.onclick = () => { box.remove(); onClose(); };
  const btns = el("div", "row"); btns.append(go, cancel); box.append(btns);

  const refresh = async () => {
    go.disabled = true; quoted = null; info.textContent = "Pricing…";
    const clip = clips.find((c) => c.id === audioSel.value);
    try {
      quoted = await post("/api/episode/lipsync/quote", { dir: EP.dir, versionId: v.id, audioClipId: audioSel.value, modelId: modelSel.value });
      const mismatch = clip && Math.abs(clip.seconds - quoted.seconds) > 0.3
        ? ` Audio is ${clip.seconds}s but the take is ${quoted.seconds}s — check "If lengths differ".` : "";
      info.textContent = `Priced on the take's ${quoted.seconds}s: $${quoted.totalUSD.toFixed(2)} (${quoted.modelLabel}, ${quoted.confidence}). Watch the result before selecting it.${mismatch}`;
      go.textContent = `Run lip sync (~$${quoted.totalUSD.toFixed(2)})`;
      go.disabled = false;
    } catch (e) { info.textContent = e.message; }
  };
  audioSel.onchange = modelSel.onchange = refresh;

  go.onclick = async () => {
    if (!quoted) return;
    const isMock = driverSel.value === "mock";
    const msg = `Lip sync "${v.modelLabel}" with "${clips.find((c) => c.id === audioSel.value).label}"?\n\n` +
      `${quoted.modelLabel} · ${quoted.seconds}s · ${isMock ? "MOCK driver — no real spend" : `~$${quoted.totalUSD.toFixed(2)} (charged to this episode's budget)`}\n` +
      `Creates a NEW take; the original is untouched. A paid take can't be undone away.`;
    if (!confirm(msg)) return;
    go.disabled = true;
    try {
      await post("/api/episode/lipsync", {
        dir: EP.dir, versionId: v.id, audioClipId: audioSel.value, modelId: modelSel.value,
        syncMode: modeSel.value, driver: driverSel.value,
        confirmedUSD: quoted.needsConfirmation ? quoted.totalUSD : undefined,
      });
      flashNote("Lip sync queued — the new take appears in the Version tray when it finishes (a few minutes).");
      await reloadEpisode(v.shotId);
    } catch (e) { fail(e); go.disabled = false; }
  };
  refresh();
  return box;
}

// "Finish at 1080p…" under an Atlas 480p draft take: Atlas re-renders the draft
// at 1080p from the draft's own prompt, images, seed and sound (so there is
// nothing to choose). Shows what the draft cost, what the finish costs and the
// days left, and always confirms. Makes a NEW take; the draft stays.
function finishPanel(v, onClose) {
  const box = el("div"); box.style.cssText = "margin:6px 0 4px 6px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel)";
  const note = el("div", "mini"); note.style.margin = "0 0 6px";
  note.textContent = "Atlas re-renders this draft at 1080p from its own prompt, images, seed and sound. The move and the cast should hold; faces, the sign and small detail are rendered again, so look closely. Only 1080p is offered. A draft can be finished any number of times within 7 days.";
  const info = el("div", "mini"); info.style.margin = "6px 0";
  box.append(note, info);
  let quoted = null;
  const go = el("button", "primary", "Finish at 1080p");
  const cancel = el("button", null, "Close");
  cancel.onclick = () => { box.remove(); onClose(); };
  const btns = el("div", "row"); btns.append(go, cancel); box.append(btns);
  go.disabled = true; info.textContent = "Pricing…";
  (async () => {
    try {
      quoted = await post("/api/episode/finish/quote", { dir: EP.dir, versionId: v.id });
      info.textContent = `Finish ${quoted.seconds}s at 1080p: $${quoted.totalUSD.toFixed(2)} (${quoted.confidence}). The draft cost $${quoted.draftUSD.toFixed(2)}, so ${quoted.bothUSD.toFixed(2)} in all.${quoted.expiresAt ? ` Finish it by ${quoted.expiresAt.slice(0, 10)} (${quoted.daysLeft} day${quoted.daysLeft === 1 ? "" : "s"} left).` : ""}`;
      go.textContent = `Finish at 1080p (~$${quoted.totalUSD.toFixed(2)})`;
      go.disabled = false;
    } catch (e) { info.textContent = e.message; }
  })();
  go.onclick = async () => {
    if (!quoted) return;
    const msg = `Finish "${v.modelLabel}" at 1080p?\n\n${quoted.seconds}s · ~$${quoted.totalUSD.toFixed(2)} (charged to this episode's budget)\nCreates a NEW take; the draft is untouched. A paid take can't be undone away.`;
    if (!confirm(msg)) return;
    go.disabled = true;
    try {
      await post("/api/episode/finish", { dir: EP.dir, versionId: v.id, confirmedUSD: quoted.needsConfirmation ? quoted.totalUSD : undefined });
      flashNote("Finish queued — the 1080p take appears in the Version tray when it finishes (a few minutes).");
      await reloadEpisode(v.shotId);
    } catch (e) { fail(e); go.disabled = false; }
  };
  return box;
}

// The "Upscale…" form under a take: pick a model, say whether to upscale just
// the trimmed part or the whole take, see the exact price from the same server
// quote the spend guards use, and always confirm before spending. Makes a NEW
// take (the original is untouched); the result is matched to the source's
// frame rate and size, so it drops into the cut in its place.
function upscalePanel(v, onClose) {
  const box = el("div"); box.style.cssText = "margin:6px 0 4px 6px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel)";
  const shot = EP.shots.find((s) => s.id === v.shotId);
  const tt = shot && shot.takeTrims && shot.takeTrims[v.id];
  const full = Number(v.seconds);
  const kept = tt ? trimSpans(tt, full) : null;
  const hasTrim = !!kept && kept.length > 0 && !isWholeTake(kept, full);
  const mk = (opts) => { const s = document.createElement("select"); opts.forEach(([val, txt]) => { const o = document.createElement("option"); o.value = val; o.textContent = txt; s.append(o); }); return s; };
  // One entry per upscale MODEL; the services that sell it (fal, Atlas, Sume) are the Driver
  // choices, each with its price for this take.
  const models = GRAMMAR.upscaleModels || [];
  const families = models.filter((m, i) => models.findIndex((x) => x.family === m.family) === i);
  const VIA_UP = { fal: "fal", atlas: "Atlas", sume: "Sume" };
  const modelSel = mk(families.map((m) => [m.family, m.label]));
  const spanSel = mk(hasTrim
    ? [["trim", `Only the part used in the cut (${+spansDuration(kept).toFixed(2)}s${kept.length > 1 ? `, ${kept.length} pieces joined` : ""})`], ["whole", `The whole take (${+full.toFixed(2)}s)`]]
    : [["whole", `The whole take (${+full.toFixed(2)}s)`]]);
  const driverSel = mk([]);
  let routeChosen = false; // once you pick a service by hand, a model change keeps it if it can
  const g = el("div", "grid g2");
  g.append(labeled("Model", modelSel), labeled("Upscale", spanSel), labeled("To", Object.assign(el("div", "mini"), { textContent: "1080p (matched to the take's shape)" })), labeled("Service", driverSel));
  box.append(g);

  const note = el("div", "mini"); note.style.margin = "6px 0";
  box.append(note);
  const info = el("div", "mini"); info.style.margin = "6px 0";
  box.append(info);
  let quoted = null;
  const go = el("button", "primary", "Upscale");
  const cancel = el("button", null, "Close");
  cancel.onclick = () => { box.remove(); onClose(); };
  const btns = el("div", "row"); btns.append(go, cancel); box.append(btns);

  const refresh = async () => {
    go.disabled = true; quoted = null; info.textContent = "Pricing…";
    const fam = models.filter((x) => x.family === modelSel.value);
    const useTrim = spanSel.value === "trim";
    try {
      const qs = await Promise.all(fam.map((r) => post("/api/episode/upscale/quote", { dir: EP.dir, versionId: v.id, modelId: r.id, useTrim }).catch(() => null)));
      // Rebuild the service list: cheapest connected first, each with its price.
      const keep = driverSel.value;
      const order = fam.map((r, i) => ({ r, q: qs[i], ready: viaReady(r.via) })).sort((a, b) => (b.ready - a.ready) || ((a.q ? a.q.totalUSD : 1e9) - (b.q ? b.q.totalUSD : 1e9)));
      driverSel.innerHTML = "";
      order.forEach(({ r, q, ready }) => {
        const o = document.createElement("option"); o.value = r.id;
        o.textContent = `${VIA_UP[r.via] || r.via} — ${q ? `$${q.totalUSD.toFixed(q.totalUSD < 1 ? 3 : 2)}${q.confidence === "exact" || q.confidence === "measured" ? "" : " est."}` : "price unavailable"}${ready ? "" : " (not connected)"}`;
        driverSel.append(o);
      });
      const mo = document.createElement("option"); mo.value = "mock"; mo.textContent = "mock (free rehearsal)"; driverSel.append(mo);
      driverSel.value = routeChosen && [...driverSel.options].some((o) => o.value === keep) ? keep : order[0].r.id;
      const row = driverSel.value === "mock" ? fam[0] : fam.find((r) => r.id === driverSel.value);
      quoted = driverSel.value === "mock" ? qs[0] : qs[fam.indexOf(row)];
      note.textContent = row ? row.note : "";
      if (!quoted) throw new Error("This route could not be priced.");
      info.textContent = `Priced on ${quoted.seconds}s: $${quoted.totalUSD.toFixed(2)} (${quoted.modelLabel}, ${quoted.confidence}). Watch the result before selecting it.`;
      go.textContent = `Upscale (~$${quoted.totalUSD.toFixed(2)})`;
      go.disabled = false;
    } catch (e) { info.textContent = e.message; }
  };
  modelSel.onchange = () => { routeChosen = false; refresh(); };
  spanSel.onchange = refresh;
  driverSel.onchange = () => {
    routeChosen = true;
    const fam = models.filter((x) => x.family === modelSel.value);
    const row = fam.find((r) => r.id === driverSel.value) || fam[0];
    note.textContent = row.note;
    post("/api/episode/upscale/quote", { dir: EP.dir, versionId: v.id, modelId: row.id, useTrim: spanSel.value === "trim" }).then((q) => {
      quoted = q;
      info.textContent = `Priced on ${q.seconds}s: $${q.totalUSD.toFixed(2)} (${q.modelLabel}, ${q.confidence}). Watch the result before selecting it.`;
      go.textContent = `Upscale (~$${q.totalUSD.toFixed(2)})`;
    }).catch((e) => { info.textContent = e.message; });
  };

  go.onclick = async () => {
    if (!quoted) return;
    const isMock = driverSel.value === "mock";
    const modelId = isMock ? models.find((x) => x.family === modelSel.value).id : driverSel.value;
    const msg = `Upscale "${v.modelLabel}" to 1080p?\n\n` +
      `${quoted.modelLabel} · ${quoted.seconds}s · ${isMock ? "MOCK driver — no real spend" : `~$${quoted.totalUSD.toFixed(2)} (charged to this episode's budget)`}\n` +
      `Creates a NEW take; the original is untouched. A paid take can't be undone away.`;
    if (!confirm(msg)) return;
    go.disabled = true;
    try {
      await post("/api/episode/upscale", {
        dir: EP.dir, versionId: v.id, modelId, useTrim: spanSel.value === "trim", driver: isMock ? "mock" : undefined,
        confirmedUSD: quoted.needsConfirmation ? quoted.totalUSD : undefined,
      });
      flashNote("Upscale queued — the new take appears in the Version tray when it finishes (a few minutes; SeedVR2 takes longer).");
      await reloadEpisode(v.shotId);
    } catch (e) { fail(e); go.disabled = false; }
  };
  refresh();
  return box;
}

function versionRow(v) {
  const block = el("div", "ver-block");
  const row = el("div", "eprow"); row.style.borderBottom = "none"; // ver-block carries the separator instead
  const stateColor = { done: "ok", error: "warn", running: "", queued: "" }[v.state] || "";

  let expanded = null; // the inline <video controls>, created lazily on first click
  const togglePlayer = () => {
    if (expanded) { expanded.remove(); expanded = null; return; }
    expanded = el("div", "ver-player");
    const vid = el("video");
    Object.assign(vid, { src: mediaURL(v.path), controls: true, autoplay: true, playsInline: true });
    expanded.append(vid);
    // The empty space beside the player holds the "use from … to …" marks
    // (Shawn, 2026-10-09): scrub, then mark in / out right there.
    if (v.state === "done" && v.path && v.shotId) {
      expanded.style.cssText = "display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap";
      expanded.append(takeMarkPanel(v, vid));
    }
    block.append(expanded);
  };
  if (v.state === "done" && v.path) {
    row.append(versionThumb(v, togglePlayer));
    // The usable-part marks live beside the player; say so on the row.
    const tb = el("button", null, "Play · trim");
    tb.title = "Open the player with Mark in / Mark out (the assembly and FCPXML use only the marked part)";
    tb.onclick = togglePlayer;
    row.append(tb);
  }

  if (v.driver === "import" || v.driver === "reuse") {
    // Not generated here — say so, instead of a "done" state and a $0.00 cost.
    const p = Object.assign(el("span", "pill"), { textContent: v.driver === "import" ? "imported" : "carried over" });
    p.title = v.importedFrom ? `From: ${v.importedFrom}` : "A clip added from outside the app — no generation cost";
    row.append(p);
  } else {
    const live = v.state === "queued" || v.state === "running";
    row.append(Object.assign(el("span", `pill ${stateColor}${live ? " live" : ""}`), { textContent: v.state }));
    if (live) block.classList.add("ver-live");
  }
  if (v.op === "finish") {
    const fp = Object.assign(el("span", "pill"), { textContent: "finish 1080p" });
    fp.title = "Made from an Atlas 480p draft: the same prompt, images and seed, rendered at 1080p";
    row.append(fp);
  }
  if (v.op === "upscale") {
    const up = Object.assign(el("span", "pill"), { textContent: "upscale" });
    up.title = `Made from another take${v.spans ? (v.spans.length > 1 ? ` (the ${v.spans.length} pieces used in the cut, joined)` : " (only the part used in the cut)") : ""} · ${v.target || "1080p"}${v.upscaleNote ? ` · ${v.upscaleNote}` : ""}`;
    row.append(up);
  }
  if (v.op === "lipsync") {
    const lp = Object.assign(el("span", "pill"), { textContent: "lip sync" });
    lp.title = `Made from another take${v.audioLabel ? ` and the audio "${v.audioLabel}"` : ""} · sync mode ${v.syncMode || "cut_off"}`;
    row.append(lp);
  }
  // Editable — a reused/recovered take (old CapCut footage, say) never went
  // through a generation call that would have named it to match the current
  // shot list, so the label has to be fixable by hand.
  const labelI = Object.assign(document.createElement("input"), { value: v.modelLabel || "" });
  labelI.style.cssText = "min-width:130px;flex:1;max-width:340px";
  labelI.title = "Rename this take's label";
  labelI.onchange = async () => {
    try { await post("/api/episode/version/relabel", { dir: EP.dir, versionId: v.id, modelLabel: labelI.value }); }
    catch (e) { fail(e); labelI.value = v.modelLabel || ""; }
  };
  row.append(labelI);
  const stripped = stripStaleLabelPrefix(v.modelLabel);
  if (stripped !== (v.modelLabel || "")) {
    const stripBtn = el("button", null, "Strip #");
    stripBtn.title = `Strip the baked-in shot code — becomes "${stripped}"`;
    stripBtn.style.cssText = "padding:2px 7px;font-size:11px";
    stripBtn.onclick = async () => {
      if (!confirm(`Strip the stale shot-code prefix from this take's label?\n\n"${v.modelLabel}"\n→ "${stripped}"`)) return;
      try {
        await post("/api/episode/version/relabel", { dir: EP.dir, versionId: v.id, modelLabel: stripped });
        await reloadEpisode(v.shotId);
      } catch (e) { fail(e); }
    };
    row.append(stripBtn);
  }
  row.append(Object.assign(el("span", "mini"), { textContent: `${v.seconds}s` }));
  if (v.billable !== false || (v.driver !== "import" && v.driver !== "reuse")) {
    row.append(Object.assign(el("span", "mini"), {
      textContent: v.actualUSD != null ? `$${Number(v.actualUSD).toFixed(2)} actual` : `$${(v.estimateUSD || 0).toFixed(2)} est`,
    }));
  }
  if (v.elapsedMs) row.append(Object.assign(el("span", "mini"), { textContent: `${Math.round(v.elapsedMs / 1000)}s` }));

  if (v.state === "error" || v.state === "cancelled") {
    // The first line only; the whole message (often a long request dump) is one click away.
    const full = String(v.error || "failed");
    const first = (full.split("\n")[0] || full).slice(0, 180) + (full.length > 180 || full.includes("\n") ? "…" : "");
    const box = el("div", "mini"); box.style.cssText = "flex:1;color:var(--bad);min-width:0";
    box.append(Object.assign(el("div"), { textContent: first }));
    if (first !== full) {
      const det = el("details"); det.style.marginTop = "2px";
      det.append(Object.assign(el("summary"), { textContent: "Full message", style: "cursor:pointer;color:var(--muted)" }));
      det.append(Object.assign(el("pre"), { textContent: full, style: "white-space:pre-wrap;word-break:break-word;font-size:11px;margin:4px 0;max-height:220px;overflow:auto;color:var(--muted)" }));
      box.append(det);
    }
    row.append(box);
  } else if (v.state === "done" && v.path) {
    const link = el("a", "mini"); link.textContent = "open in new tab"; link.href = mediaURL(v.path); link.target = "_blank";
    link.style.flex = "1";
    row.append(link);
  } else {
    row.append(Object.assign(el("div"), { style: "flex:1" }));
  }

  if (v.state === "done") {
    // Multiple takes on one shot can be selected at once (Sept 2026) — each
    // stacks onto its own export track in the order added (V1 = primary,
    // V2/V3... = alternates for auditioning in Resolve). The button toggles
    // membership rather than replacing a single choice.
    const trackLabel = v.trackIndex === 0 ? "✓ V1" : `✓ V${v.trackIndex + 1}`;
    const sel = el("button", v.selected ? "primary" : null, v.selected ? trackLabel : "Select");
    sel.title = v.selected
      ? `Selected — lands on track V${v.trackIndex + 1} of this shot's export. Click to remove.`
      : "Add this take to the shot's selection (stacks alongside any others already selected).";
    sel.onclick = async () => {
      try {
        await post("/api/episode/version/select", { dir: EP.dir, shotId: v.shotId, versionId: v.id, action: v.selected ? "remove" : "add" });
        await reloadEpisode(v.shotId);
      } catch (e) { fail(e); }
    };
    row.append(sel);
  }
  if (v.state === "done" && v.path) {
    const ls = el("button", null, "Lip sync…");
    ls.title = "Re-time this take's mouth to a recorded audio clip — makes a NEW take, costs money, asks first";
    let panel = null;
    ls.onclick = () => { if (panel) { panel.remove(); panel = null; return; } panel = lipsyncPanel(v, () => { panel = null; }); block.append(panel); };
    row.append(ls);
    if (v.draftId && v.op !== "finish") {
      const fin = el("button", null, "Finish at 1080p…");
      fin.title = "Re-render this Atlas draft at 1080p (within 7 days) — makes a NEW take, costs money, asks first";
      let finPanel = null;
      fin.onclick = () => { if (finPanel) { finPanel.remove(); finPanel = null; return; } finPanel = finishPanel(v, () => { finPanel = null; }); block.append(finPanel); };
      row.append(fin);
    }
    const upb = el("button", null, "Upscale…");
    upb.title = "Make a 1080p copy of this take (SeedVR2 or Bytedance) — makes a NEW take, costs money, asks first";
    let upPanel = null;
    upb.onclick = () => { if (upPanel) { upPanel.remove(); upPanel = null; return; } upPanel = upscalePanel(v, () => { upPanel = null; }); block.append(upPanel); };
    row.append(upb);
  }
  row.append(takeMoveSelect(v));
  if (v.state === "done" && v.path) {
    const sm = el("button", null, "Save as module"); sm.disabled = true;
    sm.title = `Package this take's prompt, frames and settings as a reusable shot module. ${MODULES_SOON}`;
    row.append(sm);
  }
  const gone = v.state === "error" || v.state === "cancelled";
  if (v.state === "queued" || v.state === "running") {
    const cx = el("button", null, "Cancel");
    cx.title = "Stop this take. If it hasn't started at the provider it costs nothing; if the provider already started it, the take keeps running and the app says so.";
    cx.onclick = async () => {
      cx.disabled = true;
      try { await post("/api/episode/version/cancel", { dir: EP.dir, versionId: v.id }); await reloadEpisode(v.shotId); }
      catch (e) { cx.disabled = false; fail(e); }
    };
    row.append(cx);
  }
  const del = el("button", null, gone ? "Dismiss" : "✕");
  del.title = gone ? "Remove this failed or cancelled take from the list (it never produced a video)." : "Remove this take from the tray (the file stays on disk).";
  del.onclick = async () => {
    if (gone) {
      try { await post("/api/episode/version/delete", { dir: EP.dir, versionId: v.id }); await reloadEpisode(v.shotId); } catch (e) { fail(e); }
      return;
    }
    const label = v.modelLabel || `${v.seconds}s take`;
    const free = v.driver === "import" || v.driver === "reuse";
    const msg = free
      ? `Delete "${label}"?\n\nThis was ${v.driver === "import" ? "imported" : "carried over"} — no generation cost. The file stays on disk; Undo can bring the record back.`
      : `Delete "${label}"?\n\nThis take cost ${v.actualUSD != null ? `$${Number(v.actualUSD).toFixed(2)} actual` : `$${(v.estimateUSD || 0).toFixed(2)} est`}. The video file stays on disk, but this can't be undone — Undo never restores a generated (paid) take.`;
    if (!confirm(msg)) return;
    try { await post("/api/episode/version/delete", { dir: EP.dir, versionId: v.id }); await reloadEpisode(v.shotId); } catch (e) { fail(e); }
  };
  row.append(del);
  block.append(row);
  if (v.prompt || v.expandedPrompt) {
    // What this take was sent, and — for H3 Max with expansion on — what fal
    // rewrote it into before the model saw it.
    const det = el("details"); det.style.cssText = "margin:0 0 4px 4px;font-size:11px";
    det.append(Object.assign(el("summary", "mini"), { textContent: v.expandedPrompt ? "Prompt sent · fal's rewrite" : "Prompt sent", style: "cursor:pointer" }));
    det.append(Object.assign(el("pre"), { textContent: v.prompt || "", style: "white-space:pre-wrap;font-size:11px;margin:4px 0" }));
    if (v.expandedPrompt) {
      det.append(Object.assign(el("div", "mini"), { textContent: "What the model received after fal's rewrite (prompt expansion):", style: "margin-top:4px" }));
      det.append(Object.assign(el("pre"), { textContent: v.expandedPrompt, style: "white-space:pre-wrap;font-size:11px;margin:4px 0;max-height:260px;overflow:auto" }));
    }
    block.append(det);
  }
  if (v.state === "done" && v.path) block.append(takeTrimLine(v, () => expanded && expanded.querySelector("video")));
  return block;
}

// "Use from … to …" on a take (Shawn, 2026-10-09: on 5b only 0:03–0:07 is
// usable). Saved on the shot by take id; the timeline and FCPXML trim to it.
// The playhead buttons read the inline player, so open the take, scrub,
// and click.
function takeTrimLine(v, playerVideo) {
  const shot = (EP.shots || []).find((s) => s.id === v.shotId);
  const cur = (shot && shot.takeTrims && shot.takeTrims[v.id]) || null;
  const line = el("div"); line.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:2px 0 6px 4px;font-size:11px";
  line.append(Object.assign(el("span", "mini"), { textContent: "Use", style: `font-weight:600${cur ? ";color:var(--ok)" : ""}` }));
  const box = (val, ph) => {
    const i = Object.assign(document.createElement("input"), { type: "number", step: "0.1", min: "0", placeholder: ph, value: val == null ? "" : String(val) });
    i.style.cssText = "width:64px;font-size:11px;padding:2px 4px";
    return i;
  };
  const inI = box(cur && cur.inSec, "start"), outI = box(cur && cur.outSec, "end");
  inI.title = "Seconds into the take where the usable part starts (blank = the start)";
  outI.title = "Seconds into the take where the usable part ends (blank = the end)";
  const status = el("span", "mini");
  const save = async (inSec, outSec, cuts) => {
    try {
      const r = await post("/api/episode/take/trim", { dir: EP.dir, shotId: v.shotId, versionId: v.id, inSec, outSec, ...(cuts ? { cuts } : {}) });
      const nCuts = (r.trim && r.trim.cuts ? r.trim.cuts.length : 0);
      flashNote(r.trim ? `Using ${fmtTrim(r.trim.inSec || 0)}–${fmtTrim(r.trim.outSec ?? r.durationSec)} of this take${nCuts ? `, ${nCuts} section${nCuts === 1 ? "" : "s"} cut out (${spansDuration(r.spans).toFixed(2)} s kept)` : ""}${r.rebuilt ? " · timeline updated" : ""}` : "Using the whole take");
      await reloadEpisode(v.shotId);
    } catch (e) { fail(e); }
  };
  const val = (i) => (i.value.trim() === "" ? null : Number(i.value));
  inI.onchange = () => save(val(inI), val(outI));
  outI.onchange = () => save(val(inI), val(outI));
  const atHead = (which) => {
    const b = el("button", null, which === "in" ? "In at playhead" : "Out at playhead");
    b.style.cssText = "font-size:10px;padding:2px 6px";
    b.title = "Open the take's player (click its thumbnail), scrub to the frame, then click";
    b.onclick = () => {
      const vid = playerVideo();
      if (!vid) { fail(new Error("Open the take's player first: click its thumbnail, then scrub to the frame.")); return; }
      const t = Math.round(vid.currentTime * 100) / 100;
      if (which === "in") save(t, val(outI)); else save(val(inI), t);
    };
    return b;
  };
  line.append(inI, Object.assign(el("span", "mini"), { textContent: "→" }), outI, Object.assign(el("span", "mini"), { textContent: "s" }), atHead("in"), atHead("out"));
  if (cur) {
    const clr = el("button", null, "Whole take");
    clr.style.cssText = "font-size:10px;padding:2px 6px";
    clr.title = "Clear the marks (and any cut-outs): use the whole take";
    clr.onclick = () => save(null, null, []);
    line.append(clr);
  }
  line.append(status);

  // Cut-outs: sections taken OUT of the middle of the usable part (a cross-fade,
  // a stumble). Type start and end seconds, or use the player's panel.
  const cuts = (cur && cur.cuts) || [];
  const cutRow = el("div"); cutRow.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 0 6px 4px;font-size:11px";
  cutRow.append(Object.assign(el("span", "mini"), { textContent: "Cut out", style: `font-weight:600${cuts.length ? ";color:var(--ok)" : ""}` }));
  const cs = box(null, "from"), ce = box(null, "to");
  cs.title = "Seconds into the take where the cut-out starts"; ce.title = "Seconds into the take where the cut-out ends";
  const addCut = el("button", null, "+ Cut out"); addCut.style.cssText = "font-size:10px;padding:2px 6px";
  addCut.title = "Remove this section from the take; the pieces either side play one after the other";
  addCut.onclick = () => {
    const a = val(cs), b = val(ce);
    if (a == null || b == null || !(b > a)) { fail(new Error("Type where the cut-out starts and a later second where it ends.")); return; }
    save(val(inI), val(outI), cuts.concat([{ startSec: a, endSec: b }]));
  };
  cutRow.append(cs, Object.assign(el("span", "mini"), { textContent: "→" }), ce, Object.assign(el("span", "mini"), { textContent: "s" }), addCut);
  cuts.forEach((c, k) => {
    const chip = el("button", null, `${fmtTrim(c.startSec)} → ${fmtTrim(c.endSec)}  ✕`);
    chip.style.cssText = "font-size:10px;padding:2px 6px";
    chip.title = "Put this section back";
    chip.onclick = () => save(val(inI), val(outI), cuts.filter((_, j) => j !== k));
    cutRow.append(chip);
  });
  const wrap = el("div"); wrap.append(line, cutRow);
  return wrap;
}

// Beside the open player: live playhead, Mark in / Mark out at the playhead,
// a bar of the marked range, and a loop of the marked part to check it.
function takeMarkPanel(v, vid, onSaved = null) {
  const shot = (EP.shots || []).find((s) => s.id === v.shotId);
  const cur = (shot && shot.takeTrims && shot.takeTrims[v.id]) || null;
  const p = el("div"); p.style.cssText = "min-width:220px;max-width:320px;display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--panel)";
  p.append(Object.assign(el("div"), { textContent: "Usable part of this take", style: "font-size:13px;font-weight:600" }));
  const now = Object.assign(el("div"), { textContent: "Playhead 0:00.00", style: "font-size:20px;font-variant-numeric:tabular-nums" });
  p.append(now);
  let mark = { inSec: cur ? cur.inSec : null, outSec: cur ? cur.outSec : null, cuts: cur && cur.cuts ? cur.cuts : [] };
  const bar = el("div"); bar.style.cssText = "position:relative;height:10px;border-radius:5px;background:var(--line)";
  const fills = el("div"); fills.style.cssText = "position:absolute;inset:0";
  const head = el("div"); head.style.cssText = "position:absolute;top:-3px;width:2px;height:16px;background:#fff";
  bar.append(fills, head);
  const range = Object.assign(el("div", "mini"), { style: "font-variant-numeric:tabular-nums" });
  const unmarked = () => mark.inSec == null && mark.outSec == null && !mark.cuts.length;
  const draw = () => {
    const d = vid.duration || 0;
    now.textContent = `Playhead ${fmtTrim(vid.currentTime)}`;
    if (!d) return;
    // One green segment per kept piece; the cut-outs show as gaps.
    const spans = trimSpans(mark, d);
    fills.replaceChildren();
    for (const sp of spans) {
      const seg = el("div");
      seg.style.cssText = `position:absolute;top:0;bottom:0;border-radius:3px;background:var(--ok);left:${(sp.inSec / d) * 100}%;width:${Math.max(0.5, ((sp.outSec - sp.inSec) / d) * 100)}%;opacity:${unmarked() ? 0.25 : 1}`;
      fills.append(seg);
    }
    head.style.left = `${(vid.currentTime / d) * 100}%`;
    const kept = spansDuration(spans);
    const a = mark.inSec ?? 0, b = mark.outSec ?? d;
    range.textContent = unmarked()
      ? `Whole take (${fmtTrim(d)}) — nothing marked`
      : mark.cuts.length
        ? `Use ${fmtTrim(a)} → ${fmtTrim(b)} minus ${mark.cuts.length} cut-out${mark.cuts.length === 1 ? "" : "s"}  (${kept.toFixed(2)} s kept of ${d.toFixed(2)} s)`
        : `Use ${fmtTrim(a)} → ${fmtTrim(b)}  (${(b - a).toFixed(2)} s of ${d.toFixed(2)} s)`;
  };
  vid.addEventListener("timeupdate", draw);
  vid.addEventListener("loadedmetadata", draw);
  vid.addEventListener("seeked", draw);
  p.append(bar, range);
  // `next` may carry `cuts`; leave it out to keep the cuts already stored.
  const save = async (next) => {
    try {
      const r = await post("/api/episode/take/trim", { dir: EP.dir, shotId: v.shotId, versionId: v.id, inSec: next.inSec, outSec: next.outSec, ...(next.cuts ? { cuts: next.cuts } : {}) });
      mark = { inSec: r.trim ? r.trim.inSec : null, outSec: r.trim ? r.trim.outSec : null, cuts: r.trim && r.trim.cuts ? r.trim.cuts : [] };
      if (shot) { shot.takeTrims = shot.takeTrims || {}; if (r.trim) shot.takeTrims[v.id] = r.trim; else delete shot.takeTrims[v.id]; }
      draw(); drawCuts();
      if (onSaved) onSaved(r);
      flashNote(r.trim ? `Marked ${fmtTrim(r.trim.inSec || 0)} → ${fmtTrim(r.trim.outSec ?? r.durationSec)}${mark.cuts.length ? ` with ${mark.cuts.length} cut-out${mark.cuts.length === 1 ? "" : "s"}` : ""}${r.rebuilt ? " · timeline updated" : ""}` : "Using the whole take");
    } catch (e) { fail(e); }
  };
  const t = () => Math.round(vid.currentTime * 100) / 100;
  const btns = el("div"); btns.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
  const mIn = el("button", "primary", "Mark in here"); mIn.title = "The usable part starts at the playhead";
  const mOut = el("button", "primary", "Mark out here"); mOut.title = "The usable part ends at the playhead";
  mIn.onclick = () => save({ inSec: t(), outSec: mark.outSec != null && mark.outSec > t() ? mark.outSec : null });
  mOut.onclick = () => save({ inSec: mark.inSec != null && mark.inSec < t() ? mark.inSec : null, outSec: t() });
  btns.append(mIn, mOut);

  // Cut-outs: scrub to where the bad stretch starts, click "Cut from here",
  // scrub to where it ends, click "Cut to here". The two pieces either side
  // then play one after the other; the green bar shows the gap.
  let cutFrom = null;
  const cFrom = el("button", null, "Cut from here"); cFrom.title = "Start of a stretch to take OUT of the middle (a cross-fade, a stumble)";
  const cTo = el("button", null, "Cut to here"); cTo.title = "End of the stretch to take out"; cTo.disabled = true;
  const cutNote = Object.assign(el("div", "mini"), { style: "min-height:1em" });
  const cutList = el("div"); cutList.style.cssText = "display:flex;flex-direction:column;gap:4px";
  const drawCuts = () => {
    cutList.replaceChildren();
    mark.cuts.forEach((c, k) => {
      const chip = el("button", null, `Cut out ${fmtTrim(c.startSec)} → ${fmtTrim(c.endSec)} (${(c.endSec - c.startSec).toFixed(2)} s)  ✕`);
      chip.style.cssText = "font-size:11px;text-align:left;padding:3px 6px";
      chip.title = "Put this section back";
      chip.onclick = () => save({ inSec: mark.inSec, outSec: mark.outSec, cuts: mark.cuts.filter((_, j) => j !== k) });
      cutList.append(chip);
    });
  };
  cFrom.onclick = () => {
    cutFrom = t(); cTo.disabled = false;
    cutNote.textContent = `Cut starts at ${fmtTrim(cutFrom)}. Scrub to where it ends, then click "Cut to here".`;
  };
  cTo.onclick = () => {
    const end = t();
    if (cutFrom == null || !(end > cutFrom)) { cutNote.textContent = "The end of a cut-out must be after its start."; return; }
    const a = cutFrom; cutFrom = null; cTo.disabled = true; cutNote.textContent = "";
    save({ inSec: mark.inSec, outSec: mark.outSec, cuts: mark.cuts.concat([{ startSec: a, endSec: end }]) });
  };
  const btnsCut = el("div"); btnsCut.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
  btnsCut.append(cFrom, cTo);

  const play = el("button", null, "Play marked part");
  play.title = "Loop the marked part (skipping the cut-outs) to check it";
  let looping = false;
  const loop = () => {
    if (!looping) return;
    const spans = trimSpans(mark, vid.duration || 0);
    if (!spans.length) return;
    const cur = spans.findIndex((sp) => vid.currentTime >= sp.inSec - 0.02 && vid.currentTime < sp.outSec);
    if (cur >= 0) return;
    // Past a piece (or inside a cut-out): on to the next piece, or back to the first.
    const next = spans.find((sp) => sp.inSec > vid.currentTime);
    vid.currentTime = next ? next.inSec : spans[0].inSec;
  };
  vid.addEventListener("timeupdate", loop);
  play.onclick = () => {
    looping = !looping; play.textContent = looping ? "Stop loop" : "Play marked part";
    if (looping) { vid.currentTime = (trimSpans(mark, vid.duration || 0)[0] || { inSec: 0 }).inSec; vid.play(); } else vid.pause();
  };
  const clr = el("button", null, "Whole take"); clr.title = "Clear the marks and any cut-outs";
  clr.onclick = () => save({ inSec: null, outSec: null, cuts: [] });
  const btns2 = el("div"); btns2.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
  btns2.append(play, clr);
  p.append(btns, btnsCut, cutNote, cutList, btns2, Object.assign(el("div", "mini"), { textContent: "The timeline and the FCPXML export use only the marked part; a cut-out becomes a break between two clips from the same file. Resolve still links the whole file, so you can extend the cut there." }));
  draw(); drawCuts();
  return p;
}

function fmtTrim(x) { const n = Number(x) || 0; const m = Math.floor(n / 60); return `${m}:${(n - m * 60).toFixed(2).padStart(5, "0")}`; }

// A small poster-frame thumbnail: hovering plays it muted right there in
// place (a quick glance), clicking opens a full inline player with sound and
// scrub controls underneath the row (a real look — camera move, action,
// pacing) without leaving the tray or downloading anything.
function versionThumb(v, onClick) {
  // Same pattern as imageThumb: the crop lives on an inner box so the hover
  // preview can escape it — a large playing pop-out, not a 42px one.
  const wrap = el("div", "ver-thumb"); wrap.style.cssText = "position:relative;overflow:visible";
  const inner = el("div"); inner.style.cssText = "width:100%;height:100%;overflow:hidden;border-radius:5px;background:#0a0d12";
  const img = el("img"); img.src = mediaURL(v.path, 160); img.loading = "lazy";
  img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block";
  inner.append(img);
  wrap.append(inner);

  let pop = null;
  wrap.onmouseenter = () => {
    if (pop && pop.isConnected) return;
    pop = el("video");
    Object.assign(pop, { src: mediaURL(v.path), muted: true, loop: true, autoplay: true, playsInline: true });
    pop.style.cssText = "width:300px;height:auto;max-height:min(540px,90vh);object-fit:contain;border:1px solid var(--line);border-radius:4px;background:#000;box-shadow:0 8px 24px rgba(0,0,0,.6);pointer-events:none";
    placePop(wrap, pop, 300);
    // Its height is only known once the video's shape is: place it again then.
    pop.addEventListener("loadedmetadata", () => { if (pop) placePop(wrap, pop, 300); });
  };
  wrap.onmouseleave = () => {
    if (!pop) return;
    pop.pause(); pop.remove(); OPEN_POPS.delete(pop); pop = null;
  };

  wrap.title = "Hover to preview, click to open the full player below";
  wrap.onclick = onClick;
  return wrap;
}

// Hover previews (Shawn, 2026-10-17: they were being cut off by the section
// boxes of the production page). A preview used to be a child of its thumbnail,
// so any ancestor with overflow:hidden or its own stacking order clipped or hid
// it. Now it lives on the page itself (position:fixed, above everything) and is
// placed from the thumbnail's position in the WINDOW: to the right when there
// is room, else the left, and clamped so it never runs off the top or bottom.
// Every open preview and the thumbnail it belongs to. A preview lives on the page, not in
// its thumbnail, so when a re-render removes the thumbnail (ticking a reference, say) the
// mouse never "leaves" it and the preview would stay forever. Any mouse move sweeps away
// previews whose thumbnail is gone or no longer under the pointer.
const OPEN_POPS = new Map();
function sweepPops(keep) {
  for (const [pop, anchor] of [...OPEN_POPS]) {
    if (pop === keep) continue;
    if (!anchor.isConnected || !anchor.matches(":hover")) { if (pop.pause) pop.pause(); pop.remove(); OPEN_POPS.delete(pop); }
  }
}
document.addEventListener("mousemove", () => sweepPops(), { passive: true });
function placePop(anchor, pop, width) {
  OPEN_POPS.set(pop, anchor);
  sweepPops(pop); // a new preview replaces any orphan left by a re-render
  if (!pop.isConnected) document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const w = width || pop.getBoundingClientRect().width || 300;
  const h = pop.getBoundingClientRect().height || 0;
  let left = r.right + 8;
  if (left + w > window.innerWidth - 8) left = Math.max(8, r.left - 8 - w);
  let top = r.top + r.height / 2 - h / 2;
  top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
  Object.assign(pop.style, { position: "fixed", left: `${left}px`, top: `${top}px`, zIndex: "1000", transform: "none", margin: "0" });
}

// ---------------- post-production: timeline, trim, export ----------------

function fmtSec(s) {
  const m = Math.floor(s / 60), ss = (s % 60).toFixed(1).padStart(4, "0");
  return `${m}:${ss}`;
}


async function loadPostProduction(card) {
  const host = card.querySelector("#postBody");
  host.innerHTML = '<div class="mini">Loading…</div>';
  try {
    const data = await api(`/api/episode/timeline?dir=${encodeURIComponent(EP.dir)}`);
    host.innerHTML = "";
    // One tool per rail entry (POST_VIEW); every tool's own reload calls back here.
    if (POST_VIEW === "dialogue") host.append(dialogueLane());
    else if (POST_VIEW === "sfx") host.append(sfxLane());
    else if (POST_VIEW === "roomtone") host.append(roomToneLane());
    else if (POST_VIEW === "resolve") host.append(fromResolveBox(card));
    else {
      const v1 = (data.timeline.tracks.find((t) => t.id === "V1") || { clips: [] }).clips;
      host.append(
        fold("post-build", "TIMELINE", v1.length ? `${v1.length} clips on V1` : "not built yet", (b) => b.append(timelineBuildBar(card, data.timeline)), true),
        fold("post-clips", "CLIP LIST · TRIMS", v1.length ? `${v1.length} clips` : "empty", (b) => b.append(timelineList(card, data.timeline))),
        fold("post-export", "EXPORT", "Resolve · CapCut", (b) => b.append(exportBar(card, data.timeline)), true),
      );
    }
    // One button to fold everything away on this page (folds, SFX scenes, any <details>).
    const all = host.querySelectorAll("details");
    if (all.length) {
      const bar = el("div", "rc-secbar");
      const ca = el("button", "rc-chip rc-closeall", "CLOSE ALL");
      ca.title = "Close every open block on this page";
      ca.onclick = () => host.querySelectorAll("details[open]").forEach((d) => { d.open = false; });
      bar.append(ca);
      host.prepend(bar);
    }
  } catch (e) { host.innerHTML = ""; fail(e); }
}


// SFX from picture: per shot, a video-to-audio model makes sound in sync
// with the selected take. Kling is the default (cleanest in the 2a test),
// Mirelo the fallback (two variants per run). Grouped by scene, collapsed.
const OPEN_SFX_SCENES = new Set();
function sfxLane() {
  const lane = el("div"); lane.style.cssText = "margin-top:14px;padding-top:8px;border-top:2px solid var(--line)";
  const shots = (EP.shots || []).filter((s) => s.sceneNum !== CUT_SCENE && (s.selectedVersions || []).length);
  const inEdit = shots.filter((s) => s.sfx && s.sfx.useId).length;
  lane.append(Object.assign(el("div"), { textContent: `SFX from picture — ${inEdit} of ${shots.length} shots have a sound in the edit`, style: "font-weight:600" }));
  lane.append(Object.assign(el("div", "mini"), {
    textContent: "A model watches the shot's selected take and makes matching sound. Kling ($0.035 a shot) is the cleanest; Mirelo ($0.01/s, two variants) is the fallback when Kling adds an artifact. Generate again for a different result. Paid on fal, so it counts against the episode cap.",
    style: "margin-bottom:6px",
  }));
  for (const g of sceneGroups().filter((x) => x.num !== CUT_SCENE)) {
    const mine = g.shots.filter((s) => (s.selectedVersions || []).length);
    if (!mine.length) continue;
    const d = document.createElement("details"); d.open = OPEN_SFX_SCENES.has(g.num);
    d.ontoggle = () => { if (d.open) OPEN_SFX_SCENES.add(g.num); else OPEN_SFX_SCENES.delete(g.num); };
    const n = mine.filter((s) => s.sfx && s.sfx.useId).length;
    d.append(Object.assign(document.createElement("summary"), { textContent: `${sceneHeading(g)}  ·  ${n}/${mine.length} with SFX`, style: "font-size:12px;font-weight:600;cursor:pointer;margin-top:4px" }));
    for (const shot of mine) d.append(sfxShotRow(shot, g.scene));
    lane.append(d);
  }
  return lane;
}

function sfxShotRow(shot, scene) {
  const row = el("div"); row.style.cssText = "padding:6px 0 6px 10px;border-top:1px solid var(--line)";
  const head = el("div", "row"); head.style.cssText = "gap:8px;align-items:baseline";
  const code = el("button", "pill", `${shot.sceneNum}${shot.shotCode}`); code.onclick = () => jumpToShot(shot.id);
  head.append(code, Object.assign(el("span"), { textContent: shot.label || shot.action || "" }));
  row.append(head);
  const sx = shot.sfx || { prompt: "", takes: [], useId: null };
  const ta = Object.assign(document.createElement("textarea"), { rows: 2, value: sx.prompt || defaultSfxPrompt(shot, scene) });
  ta.style.cssText = "width:100%;margin-top:4px";
  const count = el("span", "mini");
  const upd = () => { count.textContent = `${ta.value.trim().length}/200 (Kling's limit)`; count.style.color = ta.value.trim().length > 200 ? "#e06a6a" : ""; };
  ta.oninput = upd; upd();
  ta.onchange = async () => { try { await post("/api/episode/sfx/prompt", { dir: EP.dir, shotId: shot.id, prompt: ta.value }); } catch (e) { fail(e); } };
  row.append(ta);
  const ctl = el("div", "row"); ctl.style.cssText = "gap:6px;align-items:center;flex-wrap:wrap;margin-top:4px";
  const model = document.createElement("select"); model.style.cssText = "width:auto;font-size:12px";
  [["kling", "Kling"], ["mirelo", "Mirelo (2 variants)"]].forEach(([v, t]) => model.append(Object.assign(document.createElement("option"), { value: v, textContent: t })));
  const drv = document.createElement("select"); drv.style.cssText = "width:auto;font-size:12px";
  [["fal", "fal (paid)"], ["mock", "mock (free rehearsal)"]].forEach(([v, t]) => drv.append(Object.assign(document.createElement("option"), { value: v, textContent: t })));
  const gen = el("button", "primary", sx.takes.length ? "Generate again" : "Generate SFX");
  gen.onclick = async () => {
    try {
      const q = await post("/api/episode/sfx/quote", { dir: EP.dir, shotId: shot.id, model: model.value });
      const msg = drv.value === "mock"
        ? `Rehearse (mock, free): silent placeholder ${model.value === "mirelo" ? "variants" : "variant"} for ${shot.sceneNum}${shot.shotCode}?`
        : `Generate SFX for ${shot.sceneNum}${shot.shotCode} with ${q.label}?\n\nEstimated $${q.estimateUSD.toFixed(3)} on fal, charged to this episode's cap.${q.note ? `\n${q.note}.` : ""}`;
      if (!confirm(msg)) return;
      gen.disabled = true; gen.textContent = "Generating… (up to a minute)";
      await post("/api/episode/sfx/generate", { dir: EP.dir, shotId: shot.id, model: model.value, prompt: ta.value, driver: drv.value, confirmedUSD: q.estimateUSD });
      OPEN_SFX_SCENES.add(String(shot.sceneNum));
      await reloadEpisode();
      flashNote(`SFX for ${shot.sceneNum}${shot.shotCode} ready. Listen, then Use in edit.`);
    } catch (e) { gen.disabled = false; gen.textContent = "Generate SFX"; fail(e); }
  };
  const fi = Object.assign(document.createElement("input"), { type: "file", accept: "audio/*,.wav,.mp3,.m4a,.aac,.ogg", style: "display:none" });
  const up = el("button", "", "+ Sound file");
  up.title = "Use a sound file you already have (your own foley, a test result). It starts at the take's start.";
  up.onclick = () => fi.click();
  fi.onchange = async () => {
    const file = fi.files && fi.files[0]; if (!file) return;
    try {
      const qs = new URLSearchParams({ dir: EP.dir, shotId: shot.id, filename: file.name, label: file.name });
      const res = await fetch(`/api/episode/sfx/upload?${qs}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || (data && data.error)) throw new Error((data && data.error) || `upload failed (${res.status})`);
      OPEN_SFX_SCENES.add(String(shot.sceneNum));
      await reloadEpisode();
    } catch (e) { fail(e); }
  };
  ctl.append(model, drv, gen, up, fi, count);
  row.append(ctl);
  for (const t of sx.takes) {
    const tr = el("div", "row"); tr.style.cssText = "gap:8px;align-items:center;margin-top:4px;flex-wrap:wrap";
    const on = sx.useId === t.id;
    tr.append(Object.assign(el("span", "mini"), { textContent: `${t.label} · ${Number(t.seconds).toFixed(1)} s${t.driver === "mock" ? " · mock" : ""}`, title: t.prompt || "" }));
    tr.append(Object.assign(document.createElement("audio"), { controls: true, preload: "none", src: mediaURL(t.path), style: "height:28px" }));
    const use = el("button", on ? "pill on" : "", on ? "✓ In edit" : "Use in edit");
    use.onclick = async () => {
      try { await post("/api/episode/sfx/use", { dir: EP.dir, shotId: shot.id, takeId: on ? null : t.id }); OPEN_SFX_SCENES.add(String(shot.sceneNum)); await reloadEpisode(); } catch (e) { fail(e); }
    };
    tr.append(use);
    row.append(tr);
  }
  return row;
}

// One row per scene: prompt (from the slugline, editable), generated loops,
// the one in the edit. The timeline rebuild tiles it across the scene (A4).
function roomToneLane() {
  const lane = el("div"); lane.style.cssText = "margin-top:14px;padding-top:8px;border-top:2px solid var(--line)";
  lane.append(Object.assign(el("div"), { textContent: "Room tone — one loop per scene", style: "font-weight:600" }));
  lane.append(Object.assign(el("div", "mini"), {
    textContent: "Edit the prompt (add what the place sounds like — rain, wind, a fire), generate a loop, listen, and pick one with Use in edit. Then “Add sound to my Resolve cut” (above) repeats it across the scene as it runs in YOUR edit. Uses the ElevenLabs/Mock choice under Character voices.",
    style: "margin-bottom:6px",
  }));
  // Scene length in the current cut, from the timeline's picture clips.
  const v1 = ((EP.timeline && EP.timeline.tracks) || []).find((t) => t.id === "V1");
  const sceneOfShot = new Map((EP.shots || []).map((s) => [s.id, String(s.sceneNum)]));
  const lenOf = (num) => {
    const cs = ((v1 && v1.clips) || []).filter((c) => sceneOfShot.get(c.shotId) === String(num));
    if (!cs.length) return null;
    const end = Math.max(...cs.map((c) => c.startSec + Math.max(0, (c.sourceDurationSec || 0) - (c.headTrimSec || 0) - (c.tailTrimSec || 0))));
    return end - Math.min(...cs.map((c) => c.startSec));
  };
  const withShots = new Set((EP.shots || []).filter((s) => s.sceneNum !== CUT_SCENE).map((s) => String(s.sceneNum)));
  for (const sc of (EP.scenes || []).filter((x) => withShots.has(String(x.number)))) {
    const rt = sc.roomTone || { prompt: defaultRoomTonePrompt(sc), takes: [], useId: null };
    const row = el("div"); row.style.cssText = "padding:6px 0;border-top:1px solid var(--line)";
    const len = lenOf(sc.number);
    row.append(Object.assign(el("div"), { textContent: `${sceneHeading({ num: String(sc.number), scene: sc })}${len != null ? `  ·  ${len.toFixed(1)} s on the app's timeline (your Resolve cut may be shorter)` : ""}`, style: "font-size:12px;font-weight:600" }));
    const ta = Object.assign(document.createElement("textarea"), { rows: 2, value: rt.prompt || defaultRoomTonePrompt(sc), maxLength: 450 });
    ta.style.cssText = "width:100%;margin-top:4px";
    ta.onchange = async () => { try { await post("/api/episode/roomtone/prompt", { dir: EP.dir, sceneNum: sc.number, prompt: ta.value }); } catch (e) { fail(e); } };
    row.append(ta);
    const ctl = el("div", "row"); ctl.style.cssText = "gap:6px;align-items:center;margin-top:4px;flex-wrap:wrap";
    const secSel = document.createElement("select"); secSel.style.cssText = "width:auto;font-size:12px";
    [10, 15, 20, 22].forEach((n) => secSel.append(Object.assign(document.createElement("option"), { value: n, textContent: `${n} s loop`, selected: n === 20 })));
    const gen = el("button", "primary", rt.takes.length ? "Generate another" : "Generate loop");
    gen.onclick = async () => {
      const msg = VOICE_DRIVER === "mock"
        ? `Rehearse (mock, free): make a silent ${secSel.value} s placeholder loop for scene ${sc.number}?`
        : `Generate a ${secSel.value} s room-tone loop for scene ${sc.number} with ElevenLabs?\n\n“${ta.value.trim()}”\n\nThis uses ElevenLabs credits from your plan.`;
      if (!confirm(msg)) return;
      gen.disabled = true; gen.textContent = "Generating…";
      try {
        await post("/api/episode/roomtone/generate", { dir: EP.dir, sceneNum: sc.number, prompt: ta.value, seconds: Number(secSel.value), driver: VOICE_DRIVER });
        await reloadEpisode();
        flashNote(`Room tone for scene ${sc.number} generated. Listen, then rebuild the timeline.`);
      } catch (e) { gen.disabled = false; gen.textContent = "Generate loop"; fail(e); }
    };
    ctl.append(secSel, gen);
    row.append(ctl);
    rt.takes.forEach((t, i) => {
      const tr = el("div", "row"); tr.style.cssText = "gap:8px;align-items:center;margin-top:4px;flex-wrap:wrap";
      const inEdit = rt.useId === t.id;
      tr.append(Object.assign(el("span", "mini"), { textContent: `loop ${i + 1} · ${Number(t.seconds).toFixed(1)} s${t.driver === "mock" ? " · mock" : ""}`, title: t.prompt }));
      tr.append(Object.assign(document.createElement("audio"), { controls: true, loop: true, preload: "none", src: mediaURL(t.path), style: "height:28px" }));
      const use = el("button", inEdit ? "pill on" : "", inEdit ? "✓ In edit" : "Use in edit");
      use.onclick = async () => {
        try { await post("/api/episode/roomtone/use", { dir: EP.dir, sceneNum: sc.number, takeId: inEdit ? null : t.id }); await reloadEpisode(); } catch (e) { fail(e); }
      };
      tr.append(use);
      row.append(tr);
    });
    lane.append(row);
  }
  return lane;
}

// Which voice backend the Dialogue lane uses: ElevenLabs (real, plan
// credits) or mock (free rehearsal). Module state, survives re-renders.
let VOICE_DRIVER = "elevenlabs";
// Live voice names by id, so a voice renamed in ElevenLabs (Garbo Gravel →
// Flame) shows its current name here. Fetched at most once a minute; the
// stored name is the fallback when ElevenLabs can't be reached.
let VOICE_NAMES = { at: 0, map: new Map(), loading: null };
function liveVoiceNames(onReady) {
  if (Date.now() - VOICE_NAMES.at < 60000) return VOICE_NAMES.map;
  if (!VOICE_NAMES.loading) {
    VOICE_NAMES.loading = api("/api/voices?driver=elevenlabs")
      .then((r) => { VOICE_NAMES = { at: Date.now(), map: new Map((r.voices || []).map((v) => [v.voiceId, v.name])), loading: null }; onReady(); })
      .catch(() => { VOICE_NAMES.loading = null; VOICE_NAMES.at = Date.now(); });
  }
  return VOICE_NAMES.map;
}

// One row per speaker in the lines: their ElevenLabs voice, and a searchable
// picker over the voices in Shawn's account (with previews).
function characterVoices(rows) {
  const box = el("div"); box.style.cssText = "padding:6px 8px;border:1px solid var(--line);border-radius:8px;margin-bottom:8px";
  const top = el("div", "row"); top.style.cssText = "gap:8px;align-items:center";
  top.append(Object.assign(el("b"), { textContent: "Character voices" }));
  const drv = document.createElement("select"); drv.style.cssText = "width:auto;font-size:12px";
  [["elevenlabs", "ElevenLabs (your account)"], ["mock", "Mock — free rehearsal"]].forEach(([v, t]) => drv.append(Object.assign(document.createElement("option"), { value: v, textContent: t, selected: VOICE_DRIVER === v })));
  drv.onchange = () => { VOICE_DRIVER = drv.value; };
  top.append(drv);
  box.append(top);
  const ids = [...new Set(rows.map((r) => r.charId).filter(Boolean))];
  const chars = ids.map((id) => (EP.assets || []).find((a) => a.id === id)).filter(Boolean);
  if (!chars.length) box.append(Object.assign(el("div", "mini"), { textContent: "No speakers yet." }));
  for (const c of chars) {
    const group = (EP.assets || []).filter((a) => a.type === c.type && a.name.trim().toLowerCase() === c.name.trim().toLowerCase());
    const withV = group.find((a) => a.elevenVoiceId);
    const live = withV ? liveVoiceNames(() => { const pb = document.getElementById("postBody"); if (pb) loadPostProduction(pb.parentElement); }).get(withV.elevenVoiceId) : null;
    const row = el("div", "row"); row.style.cssText = "gap:8px;align-items:center;margin-top:4px;flex-wrap:wrap";
    row.append(Object.assign(el("span"), { textContent: c.name, style: "min-width:160px" }));
    row.append(Object.assign(el("span", "pill" + (withV ? " ok" : " warn")), { textContent: withV ? (live || withV.elevenVoiceName) : "no voice", title: withV ? `ElevenLabs voice id ${withV.elevenVoiceId}` : "" }));
    const pickHost = el("div"); pickHost.style.cssText = "flex-basis:100%";
    const choose = el("button", "", withV ? "Change…" : "Choose voice…");
    choose.onclick = () => { pickHost.innerHTML = ""; pickHost.append(voicePicker(c)); };
    row.append(choose, pickHost);
    box.append(row);
  }
  return box;
}

function voicePicker(character) {
  const w = el("div"); w.style.cssText = "margin:6px 0;padding:6px;background:var(--panel);border-radius:6px";
  const f = el("div", "row"); f.style.gap = "6px";
  const q = Object.assign(document.createElement("input"), { placeholder: `Search your ElevenLabs voices for ${character.name}…` }); q.style.flex = "1";
  const go = el("button", "", "Search");
  f.append(q, go); w.append(f);
  const list = el("div"); list.style.marginTop = "6px"; w.append(list);
  const run = async () => {
    list.innerHTML = '<div class="mini">Loading voices…</div>';
    try {
      const r = await api(`/api/voices?driver=${VOICE_DRIVER}&search=${encodeURIComponent(q.value.trim())}`);
      list.innerHTML = "";
      if (!r.status.ready) { list.append(Object.assign(el("div", "mini"), { textContent: r.status.reason, style: "color:#e06a6a" })); return; }
      if (!r.voices.length) { list.append(Object.assign(el("div", "mini"), { textContent: "No voices match. Add voices to My Voices on elevenlabs.io, then search again." })); return; }
      for (const v of r.voices) {
        const row = el("div", "row"); row.style.cssText = "gap:8px;align-items:center;margin:3px 0;flex-wrap:wrap";
        const labels = Object.values(v.labels || {}).filter(Boolean).join(", ");
        row.append(Object.assign(el("b"), { textContent: v.name }), Object.assign(el("span", "mini"), { textContent: [v.category, labels].filter(Boolean).join(" · ") }));
        if (v.previewUrl) row.append(Object.assign(document.createElement("audio"), { controls: true, preload: "none", src: v.previewUrl, style: "height:26px" }));
        const use = el("button", "primary", "Use");
        use.onclick = async () => {
          try { await post("/api/episode/character/voice", { dir: EP.dir, assetId: character.id, voiceId: v.voiceId, voiceName: v.name }); await reloadEpisode(); flashNote(`${character.name} → ${v.name}`); }
          catch (e) { fail(e); }
        };
        row.append(use);
        list.append(row);
      }
    } catch (e) { list.innerHTML = ""; fail(e); }
  };
  go.onclick = run; q.onkeydown = (e) => { if (e.key === "Enter") run(); };
  run();
  return w;
}

// Open a shot in the Shots list and bring it into view.
function jumpToShot(shotId) {
  OPEN_SHOTS.add(shotId);
  const d = document.querySelector(`details.shot[data-shot-id="${shotId}"]`);
  if (d) { d.open = true; d.scrollIntoView({ block: "start" }); }
}

function dialogueLane() {
  const lane = el("div");
  const rows = dialogueLines(EP);
  const shotsWithLines = new Set(rows.map((r) => r.shotId)).size;
  const count = (st) => rows.filter((r) => lineStatus(r) === st).length;
  lane.append(Object.assign(el("div"), {
    textContent: `Dialogue — ${rows.length} line${rows.length === 1 ? "" : "s"} in ${shotsWithLines} shot${shotsWithLines === 1 ? "" : "s"} · ${rows.length - count("no recording")} recorded · ${count("lip-synced")} lip-synced`,
    style: "font-weight:600;margin-top:4px",
  }));
  lane.append(Object.assign(el("div", "mini"), {
    textContent: "Good delivery in the take? Re-voice from take: same timing, no lip sync. Better read needed? Add your recording, Character voice, then Lip sync. Either way, pick the final one with Use in edit — the next timeline rebuild puts it on the Dialogue track.",
    style: "margin-bottom:6px",
  }));
  lane.append(characterVoices(rows));

  for (const r of rows) {
    const row = el("div"); row.style.cssText = "padding:6px 0;border-top:1px solid var(--line)";
    const head = el("div", "row"); head.style.cssText = "gap:8px;align-items:baseline;flex-wrap:wrap";
    const code = el("button", "pill", r.code); code.title = "Open this shot"; code.onclick = () => jumpToShot(r.shotId);
    const st = lineStatus(r);
    head.append(code,
      Object.assign(el("b"), { textContent: r.speaker }),
      Object.assign(el("span"), { textContent: `“${r.line}”` }),
      Object.assign(el("span", "mini"), { textContent: r.delivery ? `(${r.delivery})` : "" }),
      Object.assign(el("span", "pill" + (st === "lip-synced" ? " ok" : st === "no recording" ? " warn" : "")), { textContent: st }));
    if (r.linesInShot > 1) head.append(Object.assign(el("span", "mini"), { textContent: `line ${r.lineIndex + 1} of ${r.linesInShot} in this shot` }));
    if (r.useClipId) head.append(Object.assign(el("span", "pill ok"), { textContent: "in edit", title: "A recording is chosen for the Dialogue track" }));
    row.append(head);

    for (const rec of r.recordings) {
      const rr = el("div", "row"); rr.style.cssText = "gap:8px;align-items:center;margin-top:4px;flex-wrap:wrap";
      const what = rec.kind !== "voiced" ? "your performance" : rec.origin === "take" ? `character voice from the take (at ${Number(rec.offsetSec || 0).toFixed(2)} s)` : "character voice from your performance";
      rr.append(Object.assign(el("span", "mini"), { textContent: `${what} · ${rec.label} · ${Number(rec.seconds || 0).toFixed(1)} s` }));
      const use = el("button", rec.inEdit ? "pill on" : "", rec.inEdit ? "✓ In edit" : "Use in edit");
      use.title = rec.inEdit
        ? "This recording goes on the Dialogue track at the next timeline rebuild. Click to take it out."
        : "Make this the line's final recording: the next timeline rebuild puts it on the Dialogue track (A1).";
      use.onclick = async () => {
        try { await post("/api/episode/dialogue/use", { dir: EP.dir, shotId: r.shotId, beatId: r.beatId, audioClipId: rec.inEdit ? null : rec.id }); await reloadEpisode(); }
        catch (e) { fail(e); }
      };
      rr.append(use);
      rr.append(Object.assign(document.createElement("audio"), { controls: true, preload: "none", src: mediaURL(rec.path), style: "height:28px" }));
      if (rec.kind !== "voiced") {
        const vb = el("button", "", "Character voice");
        vb.title = "Turn this recording into the character's ElevenLabs voice (keeps your timing). Adds a new recording; yours stays.";
        vb.onclick = async () => {
          const drv = VOICE_DRIVER;
          const msg = drv === "mock"
            ? `Rehearse (mock, free): copy this recording as a fake "voiced" one for ${r.speaker}?`
            : `Turn this ${Number(rec.seconds || 0).toFixed(1)} s recording into ${r.speaker}'s ElevenLabs voice?\n\nThis uses ElevenLabs credits from your plan.`;
          if (!confirm(msg)) return;
          vb.disabled = true; vb.textContent = "Voicing…";
          try {
            const v = await post("/api/episode/voice/line", { dir: EP.dir, shotId: r.shotId, audioClipId: rec.id, driver: drv });
            await reloadEpisode();
            flashNote(`Voiced: ${v.label}`);
          } catch (e) { vb.disabled = false; vb.textContent = "Character voice"; fail(e); }
        };
        rr.append(vb);
      }
      if (!rec.linked && r.linesInShot > 1) {
        // An older recording with no line: let Shawn say which line it is.
        const sel = document.createElement("select"); sel.style.cssText = "width:auto;font-size:12px";
        sel.append(Object.assign(document.createElement("option"), { value: "", textContent: "Which line is this?" }));
        rows.filter((x) => x.shotId === r.shotId).forEach((x) => sel.append(Object.assign(document.createElement("option"), { value: x.beatId, textContent: `line ${x.lineIndex + 1}: ${x.line.slice(0, 30)}` })));
        sel.onchange = async () => {
          if (!sel.value) return;
          try { await post("/api/episode/audio/link", { dir: EP.dir, shotId: r.shotId, audioClipId: rec.id, beatId: sel.value }); await reloadEpisode(); } catch (e) { fail(e); }
        };
        rr.append(sel);
      }
      row.append(rr);
    }

    const acts = el("div", "row"); acts.style.cssText = "gap:6px;margin-top:4px";
    const fi = Object.assign(document.createElement("input"), { type: "file", accept: "audio/*,.wav,.mp3,.m4a,.aac,.ogg", style: "display:none" });
    const addRec = el("button", "", "+ Recording");
    addRec.title = "Upload your recorded performance of this line (.wav, .mp3, .m4a, .aac, .ogg)";
    addRec.onclick = () => fi.click();
    fi.onchange = async () => {
      const file = fi.files && fi.files[0];
      if (!file) return;
      addRec.disabled = true; addRec.textContent = "Uploading…";
      try {
        const qs = new URLSearchParams({ dir: EP.dir, shotId: r.shotId, beatId: r.beatId, kind: "performance", filename: file.name, label: `${r.speaker}: ${r.line.slice(0, 40)}` });
        const res = await fetch(`/api/episode/audio/upload?${qs}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || (data && data.error)) throw new Error((data && data.error) || `upload failed (${res.status})`);
        await reloadEpisode();
        flashNote(`Recording added to ${r.code}.`);
      } catch (e) { addRec.disabled = false; addRec.textContent = "+ Recording"; fail(e); }
    };
    const shotObj = (EP.shots || []).find((x) => x.id === r.shotId);
    const hasTake = shotObj && (shotObj.selectedVersions || []).length;
    const fromTake = el("button", "", "Re-voice from take…");
    fromTake.title = "The take's delivery is good: change only the voice. Uses the selected take's own audio; the result stays in sync with the picture, no lip sync needed.";
    fromTake.disabled = !hasTake;
    const ftHost = el("div"); ftHost.style.cssText = "flex-basis:100%";
    fromTake.onclick = () => {
      if (ftHost.children.length) { ftHost.innerHTML = ""; return; }
      const f = el("div", "row"); f.style.cssText = "gap:6px;align-items:center;flex-wrap:wrap;margin:4px 0;padding:6px;background:var(--panel);border-radius:6px";
      const inI = Object.assign(document.createElement("input"), { type: "number", step: "0.01", min: "0", placeholder: "start s (optional)", style: "width:130px" });
      const outI = Object.assign(document.createElement("input"), { type: "number", step: "0.01", min: "0", placeholder: "end s (optional)", style: "width:130px" });
      const nz = Object.assign(document.createElement("input"), { type: "checkbox", checked: true }); nz.style.width = "auto";
      const nzL = el("label"); nzL.style.cssText = "display:flex;gap:4px;align-items:center"; nzL.append(nz, Object.assign(el("span", "mini"), { textContent: "remove background first" }));
      const go = el("button", "primary", "Re-voice");
      go.onclick = async () => {
        const msg = VOICE_DRIVER === "mock"
          ? `Rehearse (mock, free): copy ${r.code}'s take audio as a fake "voiced" recording?`
          : `Turn ${r.code}'s take audio${inI.value || outI.value ? ` (${inI.value || 0}–${outI.value || "end"} s)` : ""} into ${r.speaker}'s ElevenLabs voice?\n\nThis uses ElevenLabs credits from your plan.`;
        if (!confirm(msg)) return;
        go.disabled = true; go.textContent = "Re-voicing…";
        try {
          const v = await post("/api/episode/voice/from-take", { dir: EP.dir, shotId: r.shotId, beatId: r.beatId, inSec: inI.value, outSec: outI.value, removeNoise: nz.checked, driver: VOICE_DRIVER });
          await reloadEpisode();
          flashNote(`Re-voiced from the take: ${v.label}. Listen, then "Use in edit".`);
        } catch (e) { go.disabled = false; go.textContent = "Re-voice"; fail(e); }
      };
      f.append(Object.assign(el("span", "mini"), { textContent: "Part of the take (leave empty for all of it):" }), inI, outI, nzL, go);
      ftHost.append(f);
    };
    const lip = el("button", "", "Lip sync…");
    lip.title = "Opens the shot: use Lip sync on its take, with this recording";
    lip.disabled = !r.recordings.length;
    lip.onclick = () => jumpToShot(r.shotId);
    const rm = el("button", "", "Remove line");
    rm.onclick = async () => {
      if (!confirm(`Remove the line “${r.line}” from ${r.code}? Its recordings stay on the shot.`)) return;
      try { await post("/api/episode/dialogue/clear", { dir: EP.dir, shotId: r.shotId, beatId: r.beatId }); await reloadEpisode(); } catch (e) { fail(e); }
    };
    acts.append(fi, addRec, fromTake, lip, rm, ftHost);
    acts.style.flexWrap = "wrap";
    row.append(acts);
    lane.append(row);
  }

  // Add a line to any shot; that shot then joins the list.
  const add = el("div"); add.style.cssText = "padding-top:8px;border-top:1px solid var(--line);margin-top:4px";
  add.append(Object.assign(el("div", "mini"), { textContent: "Add a line to a shot:" }));
  const f = el("div", "row"); f.style.cssText = "gap:6px;flex-wrap:wrap;margin-top:4px";
  const shotSel = document.createElement("select"); shotSel.style.width = "auto";
  (EP.shots || []).filter((s) => s.sceneNum !== CUT_SCENE).forEach((s) => shotSel.append(Object.assign(document.createElement("option"), { value: s.id, textContent: `${s.sceneNum}${s.shotCode} — ${(s.label || "").slice(0, 40)}` })));
  const spSel = document.createElement("select"); spSel.style.width = "auto";
  speakers(EP).forEach((sp) => spSel.append(Object.assign(document.createElement("option"), { value: sp.id, textContent: sp.name })));
  const lineI = Object.assign(document.createElement("input"), { placeholder: "The line" }); lineI.style.flex = "2";
  const delI = Object.assign(document.createElement("input"), { placeholder: "Delivery (optional)" }); delI.style.flex = "1";
  const go = el("button", "primary", "Add line");
  go.onclick = async () => {
    if (!lineI.value.trim()) { lineI.focus(); return; }
    try {
      await post("/api/episode/dialogue/line", { dir: EP.dir, shotId: shotSel.value, charId: spSel.value, line: lineI.value, delivery: delI.value });
      await reloadEpisode();
      flashNote("Line added.");
    } catch (e) { fail(e); }
  };
  f.append(shotSel, spSel, lineI, delI, go);
  add.append(f);
  lane.append(add);
  return lane;
}

// ---------- tools that read Shawn's edited cut back from Resolve ----------
// "Organize folders and footage from XML": preview first, Apply only after a
// confirm. The server refuses an Apply whose plan differs from this preview.
function fromResolveBox(card) {
  const box = el("div", "card"); box.style.cssText = "background:var(--panel2);margin:10px 0 0";
  box.append(Object.assign(el("h3"), { textContent: "From your Resolve cut", style: "font-size:13px;margin-bottom:4px" }));
  box.append(Object.assign(el("div", "mini"), {
    textContent: "Export the timeline from Resolve as FCPXML into this episode's folder, then pick it here. Nothing changes until you Apply.",
  }));
  const row = el("div", "row"); row.style.marginTop = "8px";
  const pick = document.createElement("select"); pick.style.cssText = "width:auto;max-width:420px";
  const prevBtn = el("button", "", "Organize folders and footage from XML…");
  const binsBtn = el("button", "", "Make Resolve scene-bins script");
  binsBtn.title = "Writes two scripts for Resolve's Workspace > Scripts menu: one sorts the Media Pool into scene bins, the other also imports every take of each shot.";
  binsBtn.onclick = async () => {
    try {
      const r = await post("/api/episode/resolve/scene-bins-script", { dir: EP.dir });
      out.innerHTML = "";
      out.append(Object.assign(el("div", "mini"), {
        textContent: r.installed
          ? "✓ In Resolve: Workspace > Scripts > \"" + r.names[0].replace(/\.lua$/, "") + "\" (or the \"+ all takes\" one). Restart Resolve if the menu doesn't list them yet."
          : `Could not write into Resolve's script folder. Copies are in ${r.copyIn}.`,
      }));
      for (const b of r.bins) out.append(Object.assign(el("div", "mini mono"), { textContent: `${b.name}  (${b.takes} takes)` }));
    } catch (e) { fail(e); }
  };
  const soundBtn = el("button", "", "Add sound to my Resolve cut…");
  soundBtn.title = "Places the Dialogue lines and room tone you chose (Use in edit) on YOUR Resolve edit, and writes a copy of your FCPXML with them. Your file is not changed.";
  soundBtn.onclick = async () => {
    if (!pick.value) return;
    out.innerHTML = '<div class="mini">Reading your cut…</div>';
    try { renderSoundCutPreview(out, await post("/api/episode/soundcut/preview", { dir: EP.dir, xmlPath: pick.value })); }
    catch (e) { out.innerHTML = ""; fail(e); }
  };
  row.append(pick, prevBtn, binsBtn, soundBtn);
  box.append(row);
  if (!EP.remaster) box.append(Object.assign(el("div", "mini"), { textContent: "To start a remaster from this cut: Library → + REMASTER FROM A RESOLVE CUT.", style: "margin-top:6px" }));
  if (EP.remaster) box.append(remasterInfo());
  const out = el("div"); out.style.marginTop = "8px";
  box.append(out);
  const rev = el("div", "mini"); rev.style.marginTop = "6px";
  box.append(rev);

  (async () => {
    try {
      const files = await api(`/api/episode/cut/files?dir=${encodeURIComponent(EP.dir)}`);
      if (!files.length) { pick.append(Object.assign(document.createElement("option"), { value: "", textContent: "No .fcpxml in this episode's folder" })); prevBtn.disabled = true; }
      for (const f of files) pick.append(Object.assign(document.createElement("option"), { value: f.path, textContent: `${f.name}  ·  ${new Date(f.mtime).toLocaleString()}` }));
      const last = await api(`/api/episode/organize/last?dir=${encodeURIComponent(EP.dir)}`);
      if (last) {
        rev.textContent = `Last organize: ${last.at.slice(0, 16).replace("T", " ")}, ${last.renamed} files. Resolve file: ${last.relinked} `;
        const b = el("button", "", "Reverse last organize");
        b.onclick = async () => {
          if (!confirm("Put every renamed file back and restore the episode as it was before that organize?\n\nRefused if anything was edited since.")) return;
          try { const r = await post("/api/episode/organize/reverse", { dir: EP.dir }); flashNote(`Reversed: ${r.restoredFiles} files put back.`); await reloadEpisode(); }
          catch (e) { fail(e); }
        };
        rev.append(b);
      }
    } catch (e) { fail(e); }
  })();

  prevBtn.onclick = async () => {
    if (!pick.value) return;
    prevBtn.disabled = true; out.innerHTML = '<div class="mini">Reading the cut…</div>';
    try {
      const p = await post("/api/episode/organize/preview", { dir: EP.dir, xmlPath: pick.value });
      renderOrganizePreview(out, p, pick.value);
    } catch (e) { out.innerHTML = ""; fail(e); }
    prevBtn.disabled = false;
  };
  return box;
}

function renderSoundCutPreview(out, p) {
  out.innerHTML = "";
  out.append(Object.assign(el("div"), { textContent: `Sound for your cut (${fmtSec(p.cutSeconds)}): ${p.dialogue.length} dialogue line${p.dialogue.length === 1 ? "" : "s"}, ${(p.sfx || []).length} SFX, room tone for ${p.roomtone.length} scene${p.roomtone.length === 1 ? "" : "s"}.`, style: "font-weight:600" }));
  out.append(Object.assign(el("div", "mini"), { textContent: "Only what you marked Use in edit (Sound box) is placed. Times are on your Resolve timeline." }));
  const sec = (title, lines, open = true) => {
    const d = document.createElement("details"); d.open = open; d.style.marginTop = "6px";
    d.append(Object.assign(document.createElement("summary"), { textContent: `${title} (${lines.length})` }));
    for (const t of lines) d.append(Object.assign(el("div", "mini mono"), { textContent: t }));
    out.append(d);
  };
  sec("Dialogue", p.dialogue.map((d) => `${fmtSec(d.at).padStart(6)}  ${d.code.padEnd(4)} “${d.line.slice(0, 50)}”${d.note ? `  — ${d.note}` : ""}`));
  sec("SFX", (p.sfx || []).map((f) => `${fmtSec(f.at).padStart(6)}  ${f.code.padEnd(4)} ${f.label}${f.note ? `  — ${f.note}` : ""}`));
  sec("Room tone", p.roomtone.map((r) => `scene ${r.sceneNum}: ${fmtSec(r.start)}–${fmtSec(r.end)}, ${r.tiles.length} loop${r.tiles.length === 1 ? "" : "s"} of ${Number(r.seconds).toFixed(1)} s`));
  if (p.warnings.length) sec("Notes", p.warnings, true);
  const go = el("button", "primary", "Write FCPXML with sound");
  go.style.marginTop = "8px";
  go.disabled = !p.dialogue.length && !p.roomtone.length && !(p.sfx || []).length;
  if (go.disabled) out.append(Object.assign(el("div", "mini"), { textContent: "Nothing to add yet: in the Sound box, mark a line's recording or a scene's loop with Use in edit." }));
  go.onclick = async () => {
    go.disabled = true; go.textContent = "Writing…";
    try {
      const r = await post("/api/episode/soundcut/write", { dir: EP.dir, xmlPath: p.xmlPath });
      out.innerHTML = "";
      out.append(Object.assign(el("div"), { textContent: `✓ Wrote ${r.path}`, style: "font-weight:600" }));
      out.append(Object.assign(el("div", "mini"), { textContent: `${r.added} clip${r.added === 1 ? "" : "s"} added${r.removed ? ` (${r.removed} from an earlier run replaced)` : ""}: Dialogue on lane ${r.lanes.dialogue}, Room tone on lane ${r.lanes.roomTone}, SFX on lane ${r.lanes.sfx}. In Resolve: File > Import > Timeline, pick this file. Your editing is unchanged; only these audio clips are new.` }));
    } catch (e) { go.disabled = false; go.textContent = "Write FCPXML with sound"; fail(e); }
  };
  out.append(go);
}

function renderRemasterPreview(out, p, from = null) {
  const srcDir = from ? from.dir : EP.dir;
  out.innerHTML = "";
  out.append(Object.assign(el("div"), {
    textContent: `Remaster preview: ${p.shots.length} shots, ${p.totalTargetSec.toFixed(1)} s of targets for a ${p.cutSeconds.toFixed(1)} s cut. ${p.storyboards} storyboard images copied. Nothing is generated.`,
    style: "font-weight:600",
  }));
  out.append(Object.assign(el("div", "mini"), { textContent: `New episode: ${p.name}  ·  folder ${p.folder}` }));
  const blockers = [...(p.unmatched || []).map((u) => `not matched to a take: ${u.name}`), ...(p.ambiguous || []).map((a) => `matches more than one shot (${a.shots.join(", ")}): ${a.name}`)];
  for (const w of blockers) out.append(Object.assign(el("div", "mini"), { textContent: `⚠ ${w}`, style: "color:var(--bad,#c0392b)" }));
  const sec = (title, lines, open = false) => {
    const d = document.createElement("details"); d.open = open; d.style.marginTop = "6px";
    d.append(Object.assign(document.createElement("summary"), { textContent: `${title} (${lines.length})` }));
    for (const t of lines) d.append(Object.assign(el("div", "mini mono"), { textContent: t }));
    out.append(d);
  };
  sec("Shots and target lengths", p.shots.map((s) => `${s.code.padEnd(4)} cut ${s.spanSec.toFixed(2).padStart(5)} s → target ${s.targetSeconds.toFixed(2).padStart(5)} s${s.parts.length > 1 ? `  (${s.parts.length} takes)` : ""}   ${s.label}`), true);
  sec("Left out (Add back later)", p.leftOut.map((l) => `${l.code}  ${l.status === "audio" ? "sound only" : l.status}   ${l.label}`), true);
  sec("Audio needs", p.audioNeeds.map(audioNeedLine), true);
  const go = el("button", "primary", `Create remaster (${p.shots.length} shots)`);
  go.style.marginTop = "8px";
  if (blockers.length) go.disabled = true;
  go.onclick = async () => {
    go.disabled = true; go.textContent = "Creating…";
    try {
      const r = await post("/api/episode/remaster/create", { dir: srcDir, xmlPath: p.xmlPath });
      out.innerHTML = "";
      out.append(Object.assign(el("div"), { textContent: `✓ Created ${r.name}: ${r.shots} shots, ${r.storyboardsCopied} storyboards copied.`, style: "font-weight:600" }));
      const open = el("button", "primary", "Open the remaster");
      open.onclick = () => { OPEN_SETUP_FOR = r.folder; openEpisode(r.folder, from ? from.seriesDir : undefined); };
      out.append(open);
    } catch (e) { go.disabled = false; go.textContent = "Create remaster"; fail(e); }
  };
  out.append(go);
}

function audioNeedLine(n) {
  const at = `${fmtSec(n.from)}–${fmtSec(n.to)}`;
  return n.kind === "audio-only"
    ? `${n.code}  sound only, picture cut — ${n.uses} use(s), ${n.seconds.toFixed(1)} s around ${at}   ${n.label}`
    : `${n.code}  its sound plays over other shots (sound bridge or room tone) — ${n.uses} use(s), ${n.seconds.toFixed(1)} s, ${at}   ${n.label}`;
}

// Shown in a remaster episode: where it came from, what was left out (with
// Add back), and the sound the cut needs that isn't a shot.
function remasterInfo() {
  const r = EP.remaster;
  const box = el("div"); box.style.cssText = "margin-top:10px;padding-top:8px;border-top:1px solid var(--line)";
  box.append(Object.assign(el("div"), { textContent: `Remaster of ${r.sourceDir.split("/").pop()} · from ${r.xmlPath.split("/").pop()} · ${r.handlesSec} s handles`, style: "font-weight:600" }));
  const lo = el("div"); lo.style.marginTop = "6px";
  lo.append(Object.assign(el("div", "mini"), { textContent: r.leftOut.length ? "Left out of the cut:" : "Nothing left out." }));
  for (const l of r.leftOut) {
    const row = el("div", "row"); row.style.cssText = "gap:8px;align-items:center";
    row.append(Object.assign(el("span", "mini mono"), { textContent: `${l.code}  ${l.status === "audio" ? "sound only" : l.status}   ${l.label}` }));
    if (l.code.startsWith("X")) {
      row.append(Object.assign(el("span", "mini"), { textContent: "— in the source's Cut from edit bin; restore it there first", style: "color:var(--dim)" }));
      lo.append(row);
      continue;
    }
    const b = el("button", "", "Add back");
    b.onclick = async () => {
      try { const res = await post("/api/episode/remaster/add-back", { dir: EP.dir, shotId: l.shotId }); await reloadEpisode(); flashNote(`Added back as ${res.code}. Pick its duration by hand — it isn't in the cut.`); }
      catch (e) { fail(e); }
    };
    row.append(b); lo.append(row);
  }
  box.append(lo);
  if (r.audioNeeds.length) {
    box.append(Object.assign(el("div", "mini"), { textContent: "Audio needs:", style: "margin-top:6px" }));
    for (const n of r.audioNeeds) box.append(Object.assign(el("div", "mini mono"), { textContent: audioNeedLine(n) }));
  }
  return box;
}

function renderOrganizePreview(out, p, xmlPath) {
  out.innerHTML = "";
  const renamed = p.renames.filter((r) => r.reason === "rename").length;
  const archived = p.renames.filter((r) => r.reason === "archive").length;
  out.append(Object.assign(el("div"), { textContent: `Preview: ${p.scenes.length} scenes, ${p.binCount} shots to Cut from edit, ${renamed} files renamed, ${archived} files archived.`, style: "font-weight:600" }));

  const blockers = [...(p.unmatched || []).map((u) => `not matched to a take: ${u.name}`), ...(p.ambiguous || []).map((a) => `matches more than one shot (${a.shots.join(", ")}): ${a.name}`)];
  for (const w of [...blockers, ...p.warnings]) out.append(Object.assign(el("div", "mini"), { textContent: `⚠ ${w}`, style: "color:var(--bad,#c0392b)" }));

  const sec = (title, lines, open = false) => {
    const d = document.createElement("details"); d.open = open; d.style.marginTop = "6px";
    d.append(Object.assign(document.createElement("summary"), { textContent: `${title} (${lines.length})` }));
    for (const t of lines) d.append(Object.assign(el("div", "mini mono"), { textContent: t }));
    out.append(d);
  };
  sec("Scenes", p.scenes.map((s) => `${s.from} → ${s.to}${s.from === s.to ? "  (no change)" : ""}${s.inCut ? "" : "  · not in the cut"}   ${s.heading || ""}`), true);
  sec("Shots to Cut from edit", p.shots.filter((s) => s.toScene === "X" && s.fromScene !== "X").map((s) => `${s.fromCode}  ${s.label}`), true);
  sec("Shot codes that change", p.shots.filter((s) => s.toScene !== "X" && s.fromCode !== s.toCode).map((s) => `${s.fromCode} → ${s.toCode}  ${s.label}${s.status === "audio" ? "  (sound only)" : ""}`));
  const short = (f) => f.split("/").slice(-2).join("/");
  sec("Files", p.renames.map((r) => `${r.reason === "archive" ? "archive" : "rename "}  ${short(r.from)}  →  ${short(r.to)}`));

  const apply = el("button", "primary", `Apply: rename ${renamed}, archive ${archived}, bin ${p.binCount}`);
  apply.style.marginTop = "8px";
  if (blockers.length) { apply.disabled = true; apply.title = "Fix the unmatched clips first."; }
  apply.onclick = async () => {
    const msg = [
      "Apply this organize?",
      "",
      "• Files are renamed and archived on disk (nothing is deleted).",
      "• Scenes and shots are renumbered to the cut.",
      "• Undo history moves into the organize folder: Undo can't step back past this. Use \"Reverse last organize\" instead.",
      "• A relinked FCPXML is written next to yours. Import THAT into Resolve, or your clips go offline.",
    ].join("\n");
    if (!confirm(msg)) return;
    apply.disabled = true; apply.textContent = "Organizing…";
    try {
      const r = await post("/api/episode/organize/apply", { dir: EP.dir, xmlPath, planHash: p.planHash });
      await reloadEpisode();
      flashNote(`Organized: ${r.renamed} files, ${r.binned} shots in Cut from edit. Import into Resolve: ${r.relinked}${r.binsScript && !r.binsScript.error ? " — then run the refreshed scene-bins script." : ""}`);
    } catch (e) { apply.disabled = false; apply.textContent = "Apply"; fail(e); }
  };
  out.append(apply);
}

function timelineBuildBar(card, tl) {
  const box = el("div", "row"); box.style.marginBottom = "10px";
  const v1 = tl.tracks.find((t) => t.id === "V1");
  const withSelection = (EP.shots || []).filter((s) => (s.selectedVersions || []).length).length;
  box.append(Object.assign(el("div", "mini"), {
    textContent: `${withSelection} shot(s) have a selected take · ${v1.clips.length} clip(s) on the timeline`,
    style: "flex:1",
  }));
  const build = el("button", "primary", v1.clips.length ? "Rebuild from selected takes" : "Build timeline from selected takes");
  build.disabled = !withSelection;
  build.onclick = async () => {
    build.disabled = true; build.textContent = "Building…";
    try { await post("/api/episode/timeline/rebuild", { dir: EP.dir }); await loadPostProduction(card); }
    catch (e) { fail(e); build.disabled = false; }
  };
  box.append(build);
  return box;
}

let TRIM_LIST_OPEN = false;
function timelineList(card, tl) {
  const box = el("div", "card"); box.style.cssText = "background:var(--panel2);margin:0 0 10px";
  const v1 = tl.tracks.find((t) => t.id === "V1");
  if (!v1.clips.length) {
    box.append(Object.assign(el("div", "empty"), { textContent: "No clips yet. Select takes in the Production panel, then build the timeline." }));
    return box;
  }

  const total = v1.clips.reduce((t, c) => t + Math.max(0, c.sourceDurationSec - c.headTrimSec - c.tailTrimSec), 0);
  box.append(Object.assign(el("div", "mini"), { textContent: `${v1.clips.length} clips · ${fmtSec(total)} total (post-trim) · ${tl.fps}fps`, style: "margin-bottom:8px" }));

  // The clip list repeats the shot list's order; what it adds is per-clip
  // trims. Folded away by default so the panel reads as rebuild + export.
  box.append(Object.assign(el("div", "mini"), {
    textContent: EP.remaster
      ? "Remaster: each new take starts trimmed to your cut's timing (its 0.5 s handles hidden). Adjust a clip below if the action lands differently."
      : "This is the app's own assembly for a first cut and the export. Your real edit lives in Resolve.",
    style: "margin-bottom:6px",
  }));
  const det = document.createElement("details"); det.open = TRIM_LIST_OPEN;
  det.ontoggle = () => { TRIM_LIST_OPEN = det.open; };
  det.append(Object.assign(document.createElement("summary"), { textContent: `Trim clips one by one (${v1.clips.length})`, style: "cursor:pointer;font-size:12px" }));
  v1.clips.forEach((c, i) => det.append(timelineClipRow(card, c, i, "V1")));
  box.append(det);

  // Alternate takes (a shot with more than one selected take) stack on their
  // own tracks at the same position as their shot's V1 clip — shown as their
  // own labeled sub-list rather than interleaved, since they don't drive the
  // timeline's own back-to-back sequencing the way V1's clips do.
  const altTracks = tl.tracks.filter((t) => t.kind === "video" && t.id !== "V1" && t.clips.length);
  altTracks.forEach((t) => {
    box.append(Object.assign(el("div", "mini"), { textContent: `${t.name} (${t.id}) — alternate takes, auditioned/razored in Resolve`, style: "margin-top:10px;margin-bottom:4px" }));
    t.clips.forEach((c, i) => box.append(timelineClipRow(card, c, i, t.id)));
  });

  if (tl.audioCues && tl.audioCues.length) {
    box.append(Object.assign(el("div", "mini"), { textContent: `Audio cues: ${tl.audioCues.length} (dialogue/SFX/music, pulled from beat data — see the exported edit sheet)`, style: "margin-top:8px" }));
  }
  return box;
}

function timelineClipRow(card, clip, index, trackId) {
  const row = el("div", "eprow"); row.style.alignItems = "center";
  row.append(Object.assign(el("span", "pill"), { textContent: String(index + 1).padStart(2, "0") }));
  row.append(Object.assign(el("div"), { textContent: clip.name || clip.sourcePath.split("/").pop(), style: "flex:1;min-width:0" }));
  row.append(Object.assign(el("span", "mono mini"), { textContent: `src ${clip.sourceDurationSec.toFixed(2)}s` }));

  const headI = Object.assign(document.createElement("input"), { type: "number", step: "0.1", min: "0", value: clip.headTrimSec, title: "Head trim (seconds)" });
  headI.style.cssText = "width:60px";
  const tailI = Object.assign(document.createElement("input"), { type: "number", step: "0.1", min: "0", value: clip.tailTrimSec, title: "Tail trim (seconds)" });
  tailI.style.cssText = "width:60px";
  const durOut = el("span", "pill ok");
  const updateDur = () => { durOut.textContent = `${Math.max(0, clip.sourceDurationSec - Number(headI.value) - Number(tailI.value)).toFixed(2)}s`; };
  updateDur();

  const commit = async () => {
    try {
      const updated = await post("/api/episode/timeline/clip/trim", {
        dir: EP.dir, clipId: clip.id, trackId,
        headTrimSec: Number(headI.value), tailTrimSec: Number(tailI.value),
      });
      clip.headTrimSec = updated.headTrimSec; clip.tailTrimSec = updated.tailTrimSec;
      headI.value = updated.headTrimSec; tailI.value = updated.tailTrimSec;
      updateDur();
    } catch (e) { fail(e); }
  };
  headI.onchange = commit; tailI.onchange = commit;

  row.append(Object.assign(el("span", "mini"), { textContent: "head" }), headI);
  row.append(Object.assign(el("span", "mini"), { textContent: "tail" }), tailI);
  row.append(durOut);
  return row;
}

function exportBar(card, tl) {
  const box = el("div", "card"); box.style.cssText = "background:var(--panel2);margin:0";
  box.append(Object.assign(el("h3"), { textContent: "Export", style: "font-size:13px;margin-bottom:4px" }));
  box.append(Object.assign(el("div", "mini"), {
    textContent: "FCPXML/OTIO target DaVinci Resolve. CapCut export copies clips in cut order plus a markdown edit sheet — CapCut's own import formats are restrictive, so this is the format every tool accepts.",
  }));

  if (!tl.tracks.find((t) => t.id === "V1").clips.length) {
    box.append(Object.assign(el("div", "empty"), { textContent: "Build the timeline first." }));
    return box;
  }

  const row = el("div", "row"); row.style.marginTop = "8px";
  const mkExportBtn = (label, path_, extra = {}) => {
    const b = el("button", "primary", label);
    b.onclick = async () => {
      b.disabled = true; const orig = b.textContent; b.textContent = "Exporting…";
      try {
        const res = await post(path_, { dir: EP.dir, ...extra });
        out.textContent = `✓ ${JSON.stringify(res.path || res.sheetPath || res)}`;
        if (res.binsScript) {
          out.textContent += res.binsScript.error
            ? `  ·  bins script NOT refreshed: ${res.binsScript.error}`
            : `  ·  bins script refreshed — after importing, run Workspace > Scripts > "${res.binsScript.names[0].replace(/\.lua$/, "")}"`;
        }
        b.disabled = false; b.textContent = orig;
        // Full reload, not just this panel: EP.exports feeds the export
        // history below AND gate G5, which the Gates panel renders elsewhere
        // on this same page.
        await reloadEpisode();
        return;
      } catch (e) { fail(e); }
      b.disabled = false; b.textContent = orig;
    };
    return b;
  };
  const fcpBtn = mkExportBtn("Export FCPXML (Resolve) + bins script", "/api/episode/export/fcpxml");
  fcpBtn.title = "Writes the FCPXML and refreshes this episode's scene-bins script. In Resolve: import the timeline, then Workspace > Scripts > Red Clover - Scene bins.";
  row.append(fcpBtn);
  row.append(mkExportBtn("Export OTIO", "/api/episode/export/otio"));
  row.append(mkExportBtn("Export CapCut folder + edit sheet", "/api/episode/export/capcut"));
  box.append(row);

  const out = el("div", "mini"); out.style.marginTop = "6px";
  box.append(out);

  if (EP.exports && EP.exports.length) {
    const hist = el("div"); hist.style.marginTop = "8px";
    hist.append(Object.assign(el("div", "mini"), { textContent: "Export history" }));
    EP.exports.slice().reverse().forEach((e) => {
      hist.append(Object.assign(el("div", "mini mono"), { textContent: `${e.at.slice(0, 19)}  ${e.kind}  ${e.path}` }));
    });
    box.append(hist);
  }
  return box;
}

// The app icon's five-leaf clover, flat (branding/RedCloverStudio.icns).
const CLOVER_SVG = `<svg class="rc-clover" viewBox="-16 -16 32 32" aria-hidden="true"><g fill="currentColor"><path transform="rotate(0)" d="M0 -1.4 C-1.9 -3.3 -5.2 -6.3 -5 -9.4 C-4.8 -12 -1.9 -12.8 0 -10.5 C1.9 -12.8 4.8 -12 5 -9.4 C5.2 -6.3 1.9 -3.3 0 -1.4 Z"/><path transform="rotate(72)" d="M0 -1.4 C-1.9 -3.3 -5.2 -6.3 -5 -9.4 C-4.8 -12 -1.9 -12.8 0 -10.5 C1.9 -12.8 4.8 -12 5 -9.4 C5.2 -6.3 1.9 -3.3 0 -1.4 Z"/><path transform="rotate(144)" d="M0 -1.4 C-1.9 -3.3 -5.2 -6.3 -5 -9.4 C-4.8 -12 -1.9 -12.8 0 -10.5 C1.9 -12.8 4.8 -12 5 -9.4 C5.2 -6.3 1.9 -3.3 0 -1.4 Z"/><path transform="rotate(216)" d="M0 -1.4 C-1.9 -3.3 -5.2 -6.3 -5 -9.4 C-4.8 -12 -1.9 -12.8 0 -10.5 C1.9 -12.8 4.8 -12 5 -9.4 C5.2 -6.3 1.9 -3.3 0 -1.4 Z"/><path transform="rotate(288)" d="M0 -1.4 C-1.9 -3.3 -5.2 -6.3 -5 -9.4 C-4.8 -12 -1.9 -12.8 0 -10.5 C1.9 -12.8 4.8 -12 5 -9.4 C5.2 -6.3 1.9 -3.3 0 -1.4 Z"/></g><path d="M0.2 0.6 C0.9 6 0.4 10 2.6 14.2" stroke="var(--bg)" stroke-width="2.9" fill="none" stroke-linecap="round"/><path d="M0.2 0.6 C0.9 6 0.4 10 2.6 14.2" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>`;

// ================= Stage shell (redesign, Oct 2026) =================
//
// One stage at a time instead of one 15,000px page: SCRIPT · VAULT · BOARD ·
// CLIPS · EDIT across the top, each with its own progress. Every existing
// handler still calls renderEpisode()/reloadEpisode(); renderEpisode now
// redraws the current stage only, reusing the existing panels inside it.
// Board is the new working view: scene rail (left), contact sheet (middle),
// shot inspector (right).

let STAGE = "prod";                // pre | prod | post  (pre-production, production, post-production)
let CUR_SCENE = null;              // scene number shown in Board / Clips
let SEL_SHOT = null;               // shot id open in the inspector
let RAIL_PINNED = false;
let SETTINGS_OPEN = false;
let BATCH_OPEN = false;
let RATES_OPEN = false;
let SHELL_EP_DIR = null;
let SHELL_VERSIONS = null;         // /api/episode/versions payload: takes + ledger
let SHELL_POLL = null;
let SHELL_BUSY = false;
// Shawn, 2026-10-17: the production window has too much open at once, and a lot
// of it had no way to close. Two rules now: (1) the six inspector sections start
// closed except GENERATE, a sticky bar at the top of the inspector toggles any of
// them (and "Close all"), and each open section ends with its own Close button;
// (2) every block inside GENERATE is a FOLD: one visible header (title, a
// one-line summary of what is inside, and an OPEN / CLOSE tag) that remembers
// whether you left it open.
const INSP_OPEN = new Set(["generate"]);
const FOLD_STATE = (() => { try { return new Map(Object.entries(JSON.parse(localStorage.getItem("rcFolds") || "{}"))); } catch { return new Map(); } })();
function foldSave() { try { localStorage.setItem("rcFolds", JSON.stringify(Object.fromEntries(FOLD_STATE))); } catch { /* private window */ } }
function fold(key, title, summary, build, openDefault = false) {
  const d = el("details", "rc-fold"); d.dataset.fold = key;
  d.open = FOLD_STATE.has(key) ? FOLD_STATE.get(key) : openDefault;
  d.ontoggle = () => { FOLD_STATE.set(key, d.open); foldSave(); };
  const sm = el("summary");
  sm.append(el("span", "t", title), el("span", "s", summary || ""), el("span", "x"));
  d.append(sm);
  const b = el("div", "rc-foldb"); build(b); d.append(b);
  return d;
}
try {
  const s = JSON.parse(localStorage.getItem("rcs-shell") || "{}");
  if (["pre", "prod", "post"].includes(s.stage)) STAGE = s.stage;
  RAIL_PINNED = !!s.railPinned;
} catch { /* private window — defaults are fine */ }
const saveShell = () => { try { localStorage.setItem("rcs-shell", JSON.stringify({ stage: STAGE, railPinned: RAIL_PINNED })); } catch { /* ignore */ } };

const kfOf = (shot) => (shot.beats || []).filter((b) => b.keyframe);
const shotCode = (shot) => `${shot.sceneNum ?? ""}${shot.shotCode ?? ""}`;
function shotStatus(shot) {
  const kf = kfOf(shot);
  const appr = kf.filter((b) => b.frame && b.frame.approved).length;
  const clip = (shot.selectedVersions || []).length > 0;
  const state = !kf.length ? "none" : appr < kf.length || !clip ? "warn" : "ok";
  const why = !kf.length ? "No storyboard" : appr < kf.length ? `Board ${appr}/${kf.length} approved` : !clip ? "No take selected" : "Done";
  return { boards: kf.length, appr, clip, state, why };
}
function shotThumb(shot) {
  const kf = kfOf(shot);
  const b = kf.find((x) => x.frame && x.frame.approved && x.frame.path) || kf.find((x) => x.frame && x.frame.path);
  return b ? b.frame.path : null;
}
function sceneStats(g) {
  let boards = 0, appr = 0, clips = 0;
  g.shots.forEach((s) => { const st = shotStatus(s); boards += st.boards; appr += st.appr; clips += st.clip ? 1 : 0; });
  return { boards, appr, clips, shots: g.shots.length };
}
const pctOf = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const sceneTitle = (g) => (g.num === CUT_SCENE ? "Archive (not in the edit)" : (g.scene && g.scene.heading && g.scene.heading !== "(no slugline)" ? g.scene.heading : `Scene ${g.num}`));

function meterRow(label, a, b) {
  const r = el("div", "rc-mm");
  r.append(el("span", null, label));
  const t = el("span", "t"); const i = el("i", a >= b && b ? "done" : "part"); i.style.width = `${pctOf(a, b)}%`; t.append(i);
  r.append(t, el("span", null, b ? `${a}/${b}` : "—"));
  return r;
}
function ringSvg(a, b) {
  const r = 10, c = 2 * Math.PI * r, f = b ? a / b : 0;
  if (!b) return `<svg class="rc-ring" viewBox="0 0 26 26"><circle cx="13" cy="13" r="${r}" stroke="var(--faint)" stroke-width="1.5" stroke-dasharray="2 3" fill="none"/></svg>`;
  const col = f >= 1 ? "var(--ok)" : "var(--warn)";
  return `<svg class="rc-ring" viewBox="0 0 26 26"><circle cx="13" cy="13" r="${r}" stroke="var(--line)" stroke-width="2.5" fill="none"/>`
    + `<circle cx="13" cy="13" r="${r}" stroke="${col}" stroke-width="2.5" fill="none" stroke-dasharray="${c * f} ${c}" stroke-linecap="round" transform="rotate(-90 13 13)"/>`
    + (f >= 1 ? `<path d="M9 13.2l2.6 2.6L17 10.4" stroke="var(--ok)" stroke-width="1.6" fill="none"/>` : "") + "</svg>";
}

function renderEpisode() {
  IN_EPISODE = true; scheduleUndoRefresh();
  document.body.classList.remove("rc-lib");
  document.body.classList.add("episode-view", "rc");
  if (SHELL_EP_DIR !== EP.dir) {
    SHELL_EP_DIR = EP.dir; CUR_SCENE = null; SEL_SHOT = null; SHELL_VERSIONS = null; VAULT_AUDIT = null;
    // A project with no script or shots yet opens on the guided setup.
    if (!(EP.scenes || []).length && !(EP.shots || []).length) { STAGE = "pre"; VAULT_VIEW = "script"; }
    // A remaster just made from a Resolve cut opens on Setup's "From the cut".
    if (OPEN_SETUP_FOR === EP.dir) { STAGE = "pre"; VAULT_VIEW = "script"; OPEN_SETUP_FOR = null; }
  }
  const groups = sceneGroups().filter((g) => g.num !== CUT_SCENE || g.shots.length);
  if (!groups.some((g) => g.num === CUR_SCENE)) CUR_SCENE = (groups.find((g) => g.shots.length) || groups[0] || {}).num || null;
  const g = groups.find((x) => x.num === CUR_SCENE);
  if (!(EP.shots || []).some((s) => s.id === SEL_SHOT)) SEL_SHOT = g && g.shots[0] ? g.shots[0].id : null;

  // Panels scroll on their own now, so keep each one's place across a redraw.
  const keep = {};
  document.querySelectorAll("[data-keep-scroll]").forEach((n) => { keep[n.dataset.keepScroll] = n.scrollTop; });

  const root = app();
  root.innerHTML = "";
  root.append(stageBar());
  const body = el("div", "rc-body");
  if (STAGE === "prod") body.append(boardStage(groups, g));
  else if (STAGE === "pre") body.append(vaultStage());
  else body.append(postStage(groups));
  root.append(body);
  root.append(statusBar());
  if (SETTINGS_OPEN) root.append(settingsDrawer());
  if (BATCH_OPEN && STAGE === "prod") root.append(batchDrawer());

  document.querySelectorAll("[data-keep-scroll]").forEach((n) => { if (keep[n.dataset.keepScroll] != null) n.scrollTop = keep[n.dataset.keepScroll]; });
  fillMeter();
  refreshShellVersions();
}

function goStage(s) { STAGE = s; saveShell(); renderEpisode(); const p = document.querySelector("[data-keep-scroll]"); if (p) p.scrollTop = 0; }
function goScene(num) {
  CUR_SCENE = num;
  const g = sceneGroups().find((x) => x.num === num);
  SEL_SHOT = g && g.shots[0] ? g.shots[0].id : null;
  renderEpisode();
  document.querySelectorAll('[data-keep-scroll="sheet"],[data-keep-scroll="insp"]').forEach((n) => { n.scrollTop = 0; });
}

// ---------- stage bar ----------
function stageBar() {
  const shots = EP.shots || [];
  const kf = shots.flatMap(kfOf);
  const appr = kf.filter((b) => b.frame && b.frame.approved).length;
  const clips = shots.filter((s) => (s.selectedVersions || []).length).length;
  const vault = groupAssets(EP.assets || []).length;
  const nScenes = (EP.scenes || []).length;
  const vGroups = groupAssets(EP.assets || []);
  const vDone = vGroups.filter(assetDone).length;
  const stages = [
    ["pre", "01 PRE-PRODUCTION", `${nScenes} SCENES · ${vDone}/${vault} ASSETS READY`, pctOf((nScenes ? 1 : 0) + vDone, 1 + vault)],
    ["prod", "02 PRODUCTION", `BOARDS ${appr}/${kf.length} · TAKES ${clips}/${shots.length}`, pctOf(appr + clips, kf.length + shots.length)],
    ["post", "03 POST-PRODUCTION", `ASSEMBLY ${clips}/${shots.length} SHOTS CUT IN`, pctOf(clips, shots.length)],
  ];
  const h = el("header", "rc-top");
  const logo = el("button", "rc-logo");
  // "Series — Episode — Version": the series reads big, the rest sits under it.
  // The mark is the app icon's five-leaf clover, flat (branding/RedCloverStudio.icns).
  const [series, ...rest] = String(EP.name || "").split(/\s+—\s+/);
  logo.innerHTML = `<span class="title">${CLOVER_SVG}<span></span></span><span class="sub"><span></span><i>← LIBRARY</i></span>`;
  logo.querySelector(".title span").textContent = series;
  logo.querySelector(".sub span").textContent = rest.join(" — ").toUpperCase();
  logo.title = `${EP.name || ""} — click to go back to the Library`;
  logo.onclick = renderLibrary;
  h.append(logo);
  const st = el("nav", "rc-stages");
  stages.forEach(([id, name, sub, pct]) => {
    const b = el("button", "rc-st" + (STAGE === id ? " on" : ""));
    b.append(el("b", null, name), el("span", null, sub));
    const pg = el("div", "pg"); const i = el("i"); i.style.width = `${pct}%`; pg.append(i); b.append(pg);
    b.onclick = () => goStage(id);
    st.append(b);
  });
  h.append(st);
  const m = el("div", "rc-meter");
  m.innerHTML = `<div class="v" id="rcMeter"><b>—</b><small>LOADING COST</small></div>`;
  const gear = el("button", "rc-gear", "⚙︎");
  gear.title = "Project settings: format, style, ban list, default model, budget";
  gear.onclick = () => { SETTINGS_OPEN = !SETTINGS_OPEN; renderEpisode(); };
  m.append(gear);
  h.append(m);
  return h;
}
function fillMeter() {
  const box = document.getElementById("rcMeter");
  const led = SHELL_VERSIONS && SHELL_VERSIONS.ledger;
  if (!box || !led) return;
  box.innerHTML = "";
  const v = el("b", null, `$${led.committedUSD.toFixed(2)}`);
  const cap = el("span", null, ` /${led.budgetCapUSD.toFixed(2)}`);
  const sm = el("small", led.inFlightUSD > 0 ? "warn" : null, led.inFlightUSD > 0 ? `$${led.inFlightUSD.toFixed(2)} IN FLIGHT` : `$${led.remainingUSD.toFixed(2)} LEFT`);
  box.append(v, cap, sm);
  box.title = `Spent on this episode, against its budget cap. Confirmation required above $${led.confirmAboveUSD.toFixed(2)}.`;
}

// Takes + ledger, fetched beside the episode. Polls only while a take is in
// flight; when the last one lands, reloads the episode so status updates.
async function refreshShellVersions() {
  if (!EP) return;
  const dir = EP.dir;
  try {
    const data = await api(`/api/episode/versions?dir=${encodeURIComponent(dir)}`);
    if (!EP || EP.dir !== dir || !IN_EPISODE) return;
    SHELL_VERSIONS = data;
    fillMeter(); fillTakes();
    clearTimeout(SHELL_POLL);
    const busy = data.versions.some((v) => v.state === "queued" || v.state === "running");
    const landed = SHELL_BUSY && !busy;
    SHELL_BUSY = busy;
    if (busy) SHELL_POLL = setTimeout(() => { if (IN_EPISODE) refreshShellVersions(); }, 5000);
    else if (landed) await reloadEpisode();
  } catch { /* the meter just stays on its last value */ }
}

// ---------- scene rail ----------
function sceneRail(groups) {
  const nav = el("nav", "rc-rail" + (RAIL_PINNED ? " pinned" : ""));
  const pin = el("button", "rc-pin", RAIL_PINNED ? "⇤ UNPIN" : "⇥ PIN");
  pin.title = RAIL_PINNED ? "Let the scene list tuck away" : "Keep the scene list open";
  pin.onclick = () => { RAIL_PINNED = !RAIL_PINNED; saveShell(); nav.classList.toggle("pinned", RAIL_PINNED); pin.textContent = RAIL_PINNED ? "⇤ UNPIN" : "⇥ PIN"; };
  nav.append(pin);
  groups.forEach((g) => {
    const s = sceneStats(g);
    const row = el("button", "rc-rl" + (g.num === CUR_SCENE ? " on" : ""));
    row.title = sceneHeading(g);
    const num = el("div", "num");
    num.innerHTML = `<b></b>${ringSvg(s.appr + s.clips, s.boards + s.shots)}`;
    num.querySelector("b").textContent = g.num === CUT_SCENE ? "ARC" : String(g.num).padStart(2, "0");
    const body = el("div", "body");
    body.append(el("div", "hd", sceneTitle(g)));
    if (s.shots) body.append(meterRow("BOARD", s.appr, s.boards), meterRow("CLIP", s.clips, s.shots));
    else body.append(el("div", "rc-muted", "No shots yet"));
    row.append(num, body);
    row.onclick = () => goScene(g.num);
    if (g.num !== CUT_SCENE) dragScene(row, g, groups);
    else archiveDropTarget(row);
    nav.append(row);
  });
  // The Archive is always a drop target, even before anything is in it.
  if (!groups.some((g) => g.num === CUT_SCENE)) {
    const row = el("div", "rc-rl rc-arch-empty");
    row.title = "Drag a shot here to archive it: it leaves the edit and every export, and can be restored later";
    const num = el("div", "num"); num.append(el("b", null, "ARC"));
    const body = el("div", "body"); body.append(el("div", "hd", "Archive"), el("div", "rc-muted", "Drag shots here"));
    row.append(num, body);
    archiveDropTarget(row);
    nav.append(row);
  }
  nav.append(el("div", "rc-spacer"), el("div", "rc-legend", "RING = BOARDS + CLIPS DONE"));
  return nav;
}

// ---------- board stage ----------
function boardStage(groups, g) {
  const wrap = el("div", "rc-board");
  wrap.append(sceneRail(groups), contactSheet(g), inspector((EP.shots || []).find((s) => s.id === SEL_SHOT)));
  return wrap;
}

function contactSheet(g) {
  const sec = el("section", "rc-sheet");
  sec.dataset.keepScroll = "sheet";
  if (!g) { sec.append(el("div", "rc-emptyst", "No scenes yet — import the script in SCRIPT.")); return sec; }
  const s = sceneStats(g);
  const sh = el("div", "rc-sh");
  const t = el("span"); t.append(el("b", null, g.num === CUT_SCENE ? "ARCHIVE" : `SC ${g.num}`), document.createTextNode(` · ${sceneTitle(g).toUpperCase()}`));
  sh.append(t);
  const right = el("span", "rc-shr");
  right.append(el("span", null, s.shots ? `${s.shots} SHOTS · BOARDS ${s.appr}/${s.boards} · CLIPS ${s.clips}/${s.shots}` : "NO SHOTS"));
  const add = el("button", "rc-btn", "+ SHOT");
  add.title = "Add a shot at the end of this scene";
  add.onclick = () => (g.shots.length ? insertShotAfter(g.shots[g.shots.length - 1]) : addShotToScene(g));
  right.append(add);
  const batch = el("button", "rc-btn", "BATCH");
  batch.title = "Fan-out: one approved frame to several models at once, plus the budget and every take in the episode";
  batch.onclick = () => { BATCH_OPEN = !BATCH_OPEN; renderEpisode(); };
  right.append(batch);
  sh.append(right);
  sec.append(sh);
  // Scene numbering (moved here from the old Shots list).
  if (g.num !== CUT_SCENE) {
    const tools = el("details", "rc-scenetools");
    tools.append(Object.assign(el("summary"), { textContent: "SCENE TOOLS" }));
    tools.append(sceneRenumberControls(g));
    // Claude's shot proposals, for scenes that already have shots too (it
    // sat under every scene before the redesign). Stays closed; a saved
    // proposal is flagged on its summary line.
    if (g.shots.length && (EP.scenes || []).some((x) => String(x.number) === String(g.num))) {
      tools.append(claudeShotsTool(g));
    }
    sec.append(tools);
  }

  if (!g.shots.length) {
    const e = el("div", "rc-emptyst");
    e.append(el("div", null, "This scene hasn't been broken into shots yet."));
    if ((EP.scenes || []).some((x) => String(x.number) === String(g.num))) e.append(claudeShotsTool(g));
    sec.append(e);
  } else {
    const cells = el("div", "rc-cells");
    g.shots.forEach((shot) => {
      const st = shotStatus(shot);
      const c = el("button", "rc-cell" + (shot.id === SEL_SHOT ? " sel" : ""));
      c.dataset.shot = shot.id;
      const h = el("div", "h"); h.append(el("span", null, shotCode(shot)));
      const lamp = el("span", `rc-lamp ${st.state}`); lamp.title = st.why; h.append(lamp);
      c.append(h);
      const p = shotThumb(shot);
      if (p) { const im = el("img"); im.loading = "lazy"; im.src = mediaURL(p, 240); c.append(im); }
      else c.append(el("div", "noimg", "NO BOARD"));
      c.append(el("div", "lbl", shot.label || shot.action || "(untitled)"));
      if (g.num === CUT_SCENE && shot.cutFromEdit && shot.cutFromEdit.fromCode) c.append(el("div", "rc-muted", `was ${shot.cutFromEdit.fromCode}`));
      c.onclick = () => selectShot(shot.id);
      if (g.num !== CUT_SCENE) dragShot(c, shot, g);
      cells.append(c);
    });
    sec.append(cells);
    if (g.num !== CUT_SCENE) {
      const zone = el("div", "rc-arch-zone", "Drag a shot here to archive it (out of the edit, restorable)");
      archiveDropTarget(zone);
      sec.append(zone);
    }
  }
  return sec;
}

// Selecting a shot swaps the inspector only — the sheet and its images stay put.
function selectShot(id) {
  SEL_SHOT = id;
  document.querySelectorAll(".rc-cell").forEach((c) => c.classList.toggle("sel", c.dataset.shot === id));
  const old = document.querySelector(".rc-insp");
  if (old) old.replaceWith(inspector((EP.shots || []).find((s) => s.id === id)));
  fillRateChip();
  document.querySelector(".rc-cell.sel")?.scrollIntoView({ block: "nearest" });
}

// ---------- inspector ----------
function inspector(shot) {
  const a = el("aside", "rc-insp");
  a.dataset.keepScroll = "insp";
  if (!shot) { a.append(el("div", "rc-emptyst", "Pick a shot.")); return a; }
  const p = (PROMPTS.shots || []).find((x) => x.id === shot.id) || { beats: [] };
  const st = shotStatus(shot);

  const h1 = el("div", "rc-h1");
  h1.append(el("span", null, `SHOT ${shotCode(shot)}`), el("span", null, [shot.size, shot.move, EP.fmt].filter(Boolean).join(" · ").toUpperCase()));
  a.append(h1);
  const nameBox = el("div", "rc-name");
  const nameIn = inlineEdit(shot.label, async (v) => {
    await post("/api/episode/shot/update", { dir: EP.dir, shotId: shot.id, patch: { label: v } });
    await reloadEpisode(shot.id);
  }, { placeholder: shot.action || "Name this shot…" });
  nameIn.classList.add("rc-h2");
  nameIn.title = "Click to name this shot";
  nameBox.append(nameIn, el("div", "rc-namehint", shot.label ? "Click the name to rename it. Enter saves." : "Type a name for this shot and press Enter."));
  a.append(nameBox);
  if (NAME_FOCUS === shot.id) {
    NAME_FOCUS = null;
    setTimeout(() => { nameIn.focus({ preventScroll: true }); nameIn.select(); }, 0);
  }
  a.append(flowSummary(shot, p));
  a.append(costBlock(shot));
  const secBar = el("div", "rc-secbar");
  a.append(secBar);
  const secEls = {};

  const sec = (key, title, meta, build) => {
    const d = el("details", "rc-sec");
    d.dataset.sec = key;
    d.open = INSP_OPEN.has(key);
    d.ontoggle = () => { if (d.open) INSP_OPEN.add(key); else INSP_OPEN.delete(key); syncSecBar(); };
    const sm = el("summary"); sm.append(el("span", null, title));
    const m = el("span", "meta"); if (meta) m.append(meta); sm.append(m);
    d.append(sm);
    const body = el("div", "rc-secb rc-legacy"); build(body);
    // A visible way to close it from the bottom, without scrolling back to the header.
    const cl = el("button", "rc-closesec", `▲ Close ${title.toLowerCase()}`);
    cl.onclick = () => { d.open = false; d.scrollIntoView({ block: "nearest" }); };
    body.append(cl);
    d.append(body);
    a.append(d);
    secEls[key] = d;
    return d;
  };
  const SEC_BAR = [["frames", "STORYBOARDS"], ["refvideo", "REF VIDEO"], ["generate", "GENERATE"], ["prompt", "PROMPT"], ["shot", "DETAILS"], ["blocking", "BLOCKING"]];
  const barChips = {};
  const syncSecBar = () => SEC_BAR.forEach(([k]) => { if (barChips[k] && secEls[k]) barChips[k].classList.toggle("on", secEls[k].open); });

  const kf = kfOf(shot);
  sec("frames", "STORYBOARDS", `${st.appr}/${st.boards} APPROVED`, (b) => {
    if (!kf.length) { b.append(noStoryboardRow(shot)); return; }
    const slots = maxVideoImageSlots();
    const startEnd = resolveStartEndBeats(shot);
    (shot.beats || []).forEach((beat, i) => { if (beat.keyframe) b.append(boardRow(shot, beat, i, st.appr > slots && slots >= 2 ? startEnd : null)); });
  });
  const rv = shotRefVideoState(shot);
  sec("refvideo", "REFERENCE VIDEO", rv.meta, (b) => refVideoPanel(b, shot, rv));
  sec("modules", "MODULES", (shot.modules || []).length ? `${shot.modules.length} APPLIED` : "SOON", (b) => {
    b.append(el("div", "rc-note", "Apply a saved shot recipe, previz clip, motion reference or look to this shot. It shows in the wiring above and adds to the prompt only as a suggestion you can remove."));
    const ap = el("button", null, "+ APPLY MODULE"); ap.disabled = true; ap.title = MODULES_SOON;
    b.append(ap, el("div", "rc-muted", MODULES_SOON));
  });
  // The Generate pane lists this shot's takes itself, so no separate section.
  const nTakes = (shot.versions || []).length;
  sec("generate", "GENERATE + TAKES", nTakes ? `${(shot.selectedVersions || []).length} SELECTED · ${nTakes} TAKE${nTakes === 1 ? "" : "S"}` : "NO TAKES YET", (b) => b.append(videoGeneratePane(shot)));
  sec("prompt", "PROMPT", null, (b) => b.append(videoPromptSection(shot, p)));
  sec("shot", "SHOT DETAILS", null, (b) => { b.append(shotActions(shot)); shotFieldsInto(b, shot, p); });
  const axis = episodeAxisWarnings(EP.shots || []).some((w) => w.shotACode === shotCode(shot) || w.shotBCode === shotCode(shot));
  const bm = el("span", axis ? "warn" : shot.blockingInPrompt ? "on" : null, !shot.blocking ? "NOT SET" : `${axis ? "CHECK 180° LINE" : "AXIS OK"}${shot.blockingInPrompt ? " · IN PROMPT" : ""}`);
  sec("blocking", "BLOCKING", bm, (b) => { b.append(blockingPromptToggle(shot)); b.append(blockingWidget(shot)); });
  // The sticky bar: toggle any section from wherever you have scrolled to, or close the lot.
  SEC_BAR.forEach(([k, label]) => {
    const b = el("button", "rc-chip", label);
    b.title = `Open or close ${label.toLowerCase()}`;
    b.onclick = () => {
      const d = secEls[k]; if (!d) return;
      d.open = !d.open;
      if (d.open) d.scrollIntoView({ block: "start", behavior: "smooth" });
    };
    barChips[k] = b; secBar.append(b);
  });
  const closeAll = el("button", "rc-chip rc-closeall", "CLOSE ALL");
  closeAll.title = "Close every section, every open block inside them, any image picker and the reference manager";
  closeAll.onclick = () => {
    // Update what is remembered FIRST: a re-render below reads it before the
    // browser has fired the toggle events.
    INSP_OPEN.clear();
    Object.values(secEls).forEach((d) => { d.open = false; });
    a.querySelectorAll("details.rc-fold").forEach((d) => { d.open = false; FOLD_STATE.set(d.dataset.fold, false); });
    foldSave();
    a.querySelectorAll("details.board").forEach((d) => { d.open = false; });
    const needRender = OPEN_PICKERS.size > 0 || OPEN_REF_MANAGERS.size > 0 || OPEN_BOARD_ROWS.size > 0;
    OPEN_PICKERS.clear(); OPEN_REF_MANAGERS.clear(); OPEN_BOARD_ROWS.clear();
    if (needRender) withShotAnchor(shot.id, renderEpisode);
  };
  secBar.append(closeAll);
  syncSecBar();
  fillTakes(a);
  return a;
}

// The shot card's wiring: what feeds this clip, at a glance.
function flowSummary(shot, p) {
  const { start, end } = resolveStartEndBeats(shot);
  const f = el("div", "rc-flow");
  const ins = el("div", "ins");

  const frames = el("div", "node");
  frames.append(nodeHead("FRAMES", start ? (end ? "START → END" : "START ONLY") : "NONE APPROVED"));
  const pair = el("div", "pair");
  const thumb = (b, label) => {
    if (b && b.frame && b.frame.path) { const im = el("img"); im.src = mediaURL(b.frame.path, 160); im.title = label; return im; }
    return el("div", "none", label === "start" ? "NO START" : "NO END");
  };
  pair.append(thumb(start, "start"), el("span", "ar", "→"), thumb(end, "end"));
  frames.append(pair);
  frames.onclick = () => openSec("frames");

  const refs = el("div", "node");
  const seen = new Set();
  const cur = (shot.refs || []).map((id) => (EP.assets || []).find((x) => x.id === id)).filter(Boolean)
    .filter((x) => { const k = `${x.type}:${x.name.trim().toLowerCase()}`; if (seen.has(k)) return false; seen.add(k); return true; });
  refs.append(nodeHead("REFS", String(cur.length)));
  const rr = el("div", "rr");
  cur.forEach((x) => { const s = el("span", x.path ? null : "nofile", x.name.replace(/ —.*$/, "").replace(/ \(.*\)$/, "")); s.title = `${x.type}: ${x.name}${x.path ? "" : " (no file — won't be sent)"}`; rr.append(s); });
  if (!cur.length) rr.append(el("span", "nofile", "none"));
  refs.append(rr);
  refs.onclick = () => openSec("generate");

  const pr = el("div", "node");
  pr.append(nodeHead("PROMPT", shot.videoPromptOverride ? "OVERRIDE ▸" : "AUTO ▸"));
  pr.onclick = () => openSec("prompt");
  ins.append(frames, refs);
  const rvs = shotRefVideoState(shot);
  if (rvs.sending.length) {
    const mv = el("div", "node motion");
    mv.append(nodeHead("MOTION REF", `${rvs.sending.length} · ${rvs.seconds.toFixed(1)}S`));
    const rr2 = el("div", "rr"); rvs.sending.forEach((v) => rr2.append(el("span", null, v.label || "clip"))); mv.append(rr2);
    mv.onclick = () => openSec("refvideo");
    ins.append(mv);
  }
  if ((shot.modules || []).length) {
    const md = el("div", "node motion");
    md.append(nodeHead("MODULES", String(shot.modules.length)));
    const rr3 = el("div", "rr"); shot.modules.forEach((x) => rr3.append(el("span", null, x.name || x.id))); md.append(rr3);
    md.onclick = () => openSec("modules");
    ins.append(md);
  }
  ins.append(pr);

  const wires = el("div", "wires");
  wires.innerHTML = `<svg viewBox="0 0 28 300" preserveAspectRatio="none"><path d="M0 75 C17 75 11 150 28 150 M0 215 C17 215 11 150 28 150 M0 272 C17 272 11 150 28 150" stroke="var(--acc)" fill="none" vector-effect="non-scaling-stroke"/></svg>`;

  const models = (MODELS && MODELS.video) || [];
  const sel = VIDEO_GEN_SEL.get(shot.id);
  const mid = (sel && sel.modelId) || videoModelFor(shot, EP, models.map((m) => m.id));
  const m = models.find((x) => x.id === mid);
  const mn = el("div", "model");
  if (m) {
    const secs = (sel && sel.seconds) || nearestSellable(m.durations || [5], shotStartSeconds(shot));
    mn.append(el("b", null, m.label.toUpperCase()));
    const kv = (k, v) => { const r = el("div", "kv"); r.append(el("span", null, k), el("i", null, v)); return r; };
    mn.append(kv("LEN", `${secs}S`), kv("RATE", `$${m.usdPerVideoSecond.toFixed(3)}/S`), kv("EST", `$${(secs * m.usdPerVideoSecond).toFixed(2)}`));
  } else mn.append(el("b", null, "NO MODEL"));
  mn.title = "Change model and length in GENERATE";
  mn.onclick = () => openSec("generate");

  f.append(ins, wires, mn);
  return f;
}
const nodeHead = (a, b) => { const h = el("div", "nh"); h.append(el("span", null, a), el("span", null, b)); return h; };
function openSec(key) {
  INSP_OPEN.add(key);
  const d = document.querySelector(`.rc-sec[data-sec="${key}"]`);
  if (!d) return;
  d.open = true;
  d.scrollIntoView({ block: "start", behavior: "smooth" });
}

function fillTakes(scope = document) {
  const box = scope.querySelector ? scope.querySelector("#rcTakes") : null;
  if (!box) return;
  const meta = scope.querySelector("#rcTakesMeta");
  if (!SHELL_VERSIONS) { box.replaceChildren(el("div", "rc-muted", "Loading takes…")); return; }
  const vs = SHELL_VERSIONS.versions.filter((v) => v.shotId === box.dataset.shot);
  if (meta) meta.textContent = vs.length ? `${vs.filter((v) => v.selected).length} SELECTED · ${vs.length}` : "NONE YET";
  box.replaceChildren(...(vs.length ? vs.map(versionRow) : [el("div", "rc-muted", "No takes for this shot yet.")]));
}

function shotActions(shot) {
  const act = el("div", "rc-actions");
  const mk = (label, title, fn, cls) => { const b = el("button", cls || null, label); b.title = title; b.onclick = fn; act.append(b); };
  mk("+ Before", "Add a new shot before this one", () => insertShotBefore(shot));
  mk("+ After", "Add a new shot after this one (later shots renumber)", () => insertShotAfter(shot));
  mk("↑", "Move up one place (renumbers)", () => moveShot(shot, -1));
  mk("↓", "Move down one place (renumbers)", () => moveShot(shot, 1));
  act.append(shotSceneMoveSelect(shot));
  mk("Delete shot", "Delete this shot and its storyboards", () => deleteShot(shot), "danger");
  return act;
}


// Batch: the old Production panel (budget, fan-out, every take) in a drawer.
function batchDrawer() {
  const d = el("aside", "rc-drawer wide rc-legacy");
  const top = el("div", "rc-dtop");
  top.append(el("span", null, "BATCH — FAN-OUT · BUDGET · ALL TAKES"));
  const x = el("button", "rc-gear", "×"); x.onclick = () => { BATCH_OPEN = false; renderEpisode(); };
  top.append(x);
  d.append(top, productionPanel());
  return d;
}

// ---------- settings drawer ----------
function settingsDrawer() {
  const d = el("aside", "rc-drawer rc-legacy");
  const top = el("div", "rc-dtop");
  top.append(el("span", null, "PROJECT SETTINGS"));
  const x = el("button", "rc-gear", "×"); x.onclick = () => { SETTINGS_OPEN = false; renderEpisode(); };
  top.append(x);
  d.append(top);
  const g = el("div", "grid g2");
  g.append(field("Format", EP.fmt, (v) => { EP.fmt = v; saveEp(); refreshPrompts(); }, ["9:16", "16:9"]));
  d.append(g);
  const sty = el("label", "f");
  sty.append(el("span", null, "Global style — injected into every prompt"));
  const sti = Object.assign(document.createElement("textarea"), { value: EP.style || "", rows: 2 });
  sti.onchange = () => { EP.style = sti.value; saveEp(); refreshPrompts(); };
  sty.append(sti); d.append(sty);
  const ban = el("label", "f");
  ban.append(el("span", null, "Ban list — appended as the negative block"));
  const bti = Object.assign(document.createElement("textarea"), { value: EP.ban || "", rows: 4 });
  bti.onchange = () => { EP.ban = bti.value; saveEp(); refreshPrompts(); };
  ban.append(bti); d.append(ban);
  d.append(defaultVideoModelRow());
  if (SERIES_DIR) {
    const sdBtn = el("button", null, "SAVE AS SERIES DEFAULTS");
    sdBtn.title = "New episodes of this series start with this format, style, ban list and video model";
    sdBtn.onclick = async () => {
      try {
        await post("/api/series/defaults", { seriesDir: SERIES_DIR, fmt: EP.fmt, style: EP.style || "", ban: EP.ban || "", defaultVideoModelId: EP.defaultVideoModelId || null });
        flashNote("Saved — new episodes of this series start from these settings.");
      } catch (e) { fail(e); }
    };
    const row = el("div", "rc-actions"); row.append(sdBtn); d.append(row);
  }

  const cw = el("div", "rc-drawer-conn");
  cw.append(el("h3", null, "Connections"));
  api("/api/connections").then((c) => cw.append(connectionsPanel(c))).catch(fail);
  d.append(cw);

  const led = SHELL_VERSIONS && SHELL_VERSIONS.ledger;
  if (led) {
    const b = el("div", "grid g2");
    const num = (label, val, key) => field(label, String(val), async (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) { fail(new Error(`${label}: enter a dollar amount`)); return; }
      try {
        await post("/api/episode/ledger/settings", { dir: EP.dir, budgetCapUSD: key === "cap" ? n : led.budgetCapUSD, confirmAboveUSD: key === "conf" ? n : led.confirmAboveUSD });
        await refreshShellVersions(); renderEpisode();
      } catch (e) { fail(e); }
    });
    b.append(num("Budget cap (USD)", led.budgetCapUSD, "cap"), num("Confirm above (USD)", led.confirmAboveUSD, "conf"));
    d.append(b);
  }
  return d;
}

// ---------- keyboard ----------
document.addEventListener("keydown", (e) => {
  if (!IN_EPISODE || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  if (e.key === "Escape" && (SETTINGS_OPEN || BATCH_OPEN || RATES_OPEN)) { SETTINGS_OPEN = BATCH_OPEN = RATES_OPEN = false; renderEpisode(); return; }
  // Next Escape: the page's own CLOSE ALL (shot inspector, vault card, Post page).
  if (e.key === "Escape") { const ca = document.querySelector(".rc-closeall"); if (ca) { e.preventDefault(); ca.click(); } return; }
  if (STAGE !== "prod") return;
  const groups = sceneGroups().filter((g) => g.num !== CUT_SCENE || g.shots.length);
  if (e.key === "[" || e.key === "]") {
    const k = groups.findIndex((g) => g.num === CUR_SCENE) + (e.key === "]" ? 1 : -1);
    if (groups[k]) goScene(groups[k].num);
    return;
  }
  const g = groups.find((x) => x.num === CUR_SCENE);
  if (!g || !g.shots.length) return;
  const i = g.shots.findIndex((s) => s.id === SEL_SHOT);
  const grid = document.querySelector(".rc-cells");
  const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 1;
  const to = (n) => { if (n >= 0 && n < g.shots.length && n !== i) selectShot(g.shots[n].id); };
  if (e.key === "ArrowRight") { e.preventDefault(); to(i + 1); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); to(i - 1); }
  else if (e.key === "ArrowDown") { e.preventDefault(); to(Math.min(i + cols, g.shots.length - 1)); }
  else if (e.key === "ArrowUp") { e.preventDefault(); to(Math.max(i - cols, 0)); }
  else if (e.key === "g" || e.key === "G") openSec("generate");
  else if (e.key === "b" || e.key === "B") {
    const d = document.querySelector('.rc-sec[data-sec="blocking"]');
    if (d) { d.open = !d.open; if (d.open) d.scrollIntoView({ block: "start", behavior: "smooth" }); }
  }
});

// ---------- status bar: keys (left), rate card (right) ----------
const CONF_LABEL = {
  live: ["LIVE", "Current price from the provider's pricing API (your account's price, discounts included)"],
  exact: ["LIST", "The provider's published price"],
  measured: ["MEASURED", "Calibrated against real bills"],
  estimated: ["EST.", "Estimated — not yet checked against a bill"],
  uncalibrated: ["UNCHECKED", "Ceiling guess — never checked against a bill"],
};
const confTag = (c) => {
  const [t, why] = CONF_LABEL[c] || ["?", "Unknown price source"];
  const s = el("span", `rc-conf ${c === "exact" || c === "measured" ? "ok" : "warn"}`, t);
  s.title = why;
  return s;
};

function statusBar() {
  const bar = el("footer", "rc-status");
  const keys = el("div", "keys");
  if (STAGE === "prod") keys.innerHTML = "<span><kbd>← →</kbd>shot</span><span><kbd>↑ ↓</kbd>row</span><span><kbd>[ ]</kbd>scene</span><span><kbd>G</kbd>generate</span><span><kbd>B</kbd>blocking</span><span><kbd>⌘Z</kbd>undo</span>";
  else if (STAGE === "post") keys.innerHTML = "<span><kbd>space</kbd>play / pause</span><span><kbd>← →</kbd>shot</span><span><kbd>Home</kbd>start</span><span><kbd>⌘Z</kbd>undo</span>";
  else keys.innerHTML = "<span><kbd>⌘Z</kbd>undo</span><span><kbd>Esc</kbd>close panels</span>";
  bar.append(keys);
  const chip = el("button", "rc-rate" + (RATES_OPEN ? " on" : ""));
  chip.id = "rcRateChip";
  chip.onclick = () => { RATES_OPEN = !RATES_OPEN; renderEpisode(); };
  bar.append(chip);
  if (RATES_OPEN) bar.append(ratesPopover());
  queueMicrotask(fillRateChip);
  return bar;
}

// Lit: the selected shot's video model and its price; otherwise just RATES.
function fillRateChip() {
  const chip = document.getElementById("rcRateChip");
  if (!chip) return;
  chip.replaceChildren();
  const shot = STAGE === "prod" ? (EP.shots || []).find((s) => s.id === SEL_SHOT) : null;
  const models = (MODELS && MODELS.video) || [];
  const sel = shot && VIDEO_GEN_SEL.get(shot.id);
  const m = shot && models.find((x) => x.id === ((sel && sel.modelId) || videoModelFor(shot, EP, models.map((y) => y.id))));
  if (m) {
    chip.classList.add("lit");
    chip.append(el("span", "lbl", m.label.toUpperCase()), el("b", null, `$${m.usdPerVideoSecond.toFixed(3)}/S`), confTag(m.confidence));
    if (m.live && m.tableUSD && m.usdPerVideoSecond < m.tableUSD * 0.98) { const d = el("span", "rc-drop", `↓ ${Math.round((1 - m.usdPerVideoSecond / m.tableUSD) * 100)}%`); d.title = `Cheaper right now than the app's table ($${m.tableUSD.toFixed(3)}/s)`; chip.append(d); }
  } else chip.classList.remove("lit");
  chip.append(el("span", "open", RATES_OPEN ? "RATES ▾" : "RATES ▴"));
}

function ratesPopover() {
  const pop = el("div", "rc-rates");
  const table = (title, rows) => {
    const t = el("div", "grp"); t.append(el("div", "gh", title));
    rows.forEach(([name, price, conf, note]) => {
      const r = el("div", "rr");
      const n = el("span", "nm", name); if (note) n.title = note;
      r.append(n, el("span", "pr", price), conf ? confTag(conf) : el("span"));
      t.append(r);
    });
    return t;
  };
  const was = (now, tbl) => (tbl != null && Math.abs(now - tbl) / (tbl || 1) > 0.02 ? ` (table $${Number(tbl).toFixed(3)})` : "");
  const vids = ((MODELS && MODELS.video) || []).map((m) => [m.label, `$${m.usdPerVideoSecond.toFixed(3)}/s${was(m.usdPerVideoSecond, m.tableUSD)}`, m.confidence, m.note]);
  const imgs = ((MODELS && MODELS.image) || []).map((m) => [m.label, `$${Number(m.usdPerImage).toFixed(3)}/img${was(m.usdPerImage, m.tableUSD)}`, m.confidence, m.note]);
  const watch = el("div", "rc-watch");
  pop.append(watch);
  fillPriceWatch(watch);
  pop.append(table("VIDEO", vids), table("IMAGE", imgs));
  const llmBox = el("div");
  pop.append(llmBox);
  llmInfo().then((L) => {
    llmBox.append(table("CLAUDE", (L.models || []).map((m) => [m.label, `$${m.inPerM}/$${m.outPerM} per M tok`, "exact", "Input / output price per million tokens"])));
  }).catch(() => {});
  pop.append(el("div", "foot", "LIVE prices come from the provider's pricing API (fal, OpenRouter), checked at start-up and every 6 hours, and are what quotes and the budget cap use. Others come from the app's rate table. Actual charges reconcile in the ledger."));
  return pop;
}

// ---------- per-shot cost ----------
// Everything this shot has cost so far, from the ledger. Storyboard stills
// made outside the app (or before image logging) have no ledger entry, so
// they're counted, not priced.
function costBlock(shot) {
  const entries = ((EP.ledger || {}).entries || []);
  const code = shotCode(shot).toLowerCase();
  const amt = (e) => Number(e.actualUSD ?? e.chargedUSD ?? 0) || 0;
  const mine = (e) => e.shotId === shot.id;
  const img = entries.filter((e) => e.kind === "image" && mine(e));
  const vid = entries.filter((e) => e.kind === "video" && mine(e));
  const llmRx = new RegExp(`^prompt ${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( \\(failed\\))?$`, "i");
  const cl = entries.filter((e) => e.kind === "llm" && (mine(e) || (!e.shotId && llmRx.test(e.note || ""))));
  const sum = (xs) => xs.reduce((a, e) => a + amt(e), 0);
  const loggedBeats = new Set(img.map((e) => e.beatId));
  const untracked = kfOf(shot).filter((b) => b.frame && b.frame.path && !loggedBeats.has(b.id)).length;
  const iS = sum(img), vS = sum(vid), cS = sum(cl), total = iS + vS + cS;

  const box = el("div", "rc-cost");
  const row = (k, detail, v, cls) => { const r = el("div", "r" + (cls ? ` ${cls}` : "")); r.append(el("span", "k", k), el("span", "d", detail), el("span", "v", v)); box.append(r); };
  row("IMAGES", `${img.length} generated${untracked ? ` · ${untracked} made outside the app` : ""}`, `$${iS.toFixed(2)}`);
  row("VIDEO", vid.length ? `${vid.length} take${vid.length === 1 ? "" : "s"} · avg $${(vS / vid.length).toFixed(2)}/take` : "no takes yet", `$${vS.toFixed(2)}`);
  row("CLAUDE", cl.length ? `${cl.length} draft${cl.length === 1 ? "" : "s"}` : "—", `$${cS.toFixed(2)}`);
  row("SHOT TOTAL", untracked ? "logged spend only" : "", `$${total.toFixed(2)}`, "tot");
  box.title = "From the episode ledger. Episode-wide billing adjustments aren't split per shot.";
  return box;
}

// ================= Vault (pre-production) =================
//
// Same frame as Production: rail (left) · grid (middle) · inspector (right).
// The rail lists the vault by type plus three working views: the script,
// what the script needs that the vault lacks, and unfiled images.

let VAULT_VIEW = "character";      // script | missing | unfiled | <asset type>
let VAULT_SEL = null;              // group key "type:name"
let VAULT_AUDIT = null;            // /api/episode/audit payload
let VAULT_IMG_MODEL = null;
let VAULT_N = 2;
let VAULT_BUSY = null;             // group key while generating / drafting
const VAULT_PROMPTS = new Map();   // key -> prompt being written
const VAULT_HOLDS = new Map();     // key -> { text, notes } unsaved hold draft
const VAULT_PNOTES = new Map();    // key -> Claude's notes on a drafted prompt
const VAULT_RESULTS = new Map();   // key -> [paths] generated, not yet filed
const VAULT_OPEN = new Set(["images", "hold", "generate"]);
try { const v = localStorage.getItem("rcs-vault-view"); if (v) VAULT_VIEW = v; } catch { /* ignore */ }

const groupKey = (a) => `${a.type}:${a.name.trim().toLowerCase()}`;
const groupHold = (group) => (group.map((a) => usableHold(a.identityHold)).find(Boolean)) || "";
// Ready = has an image, and a character also has an identity hold.
function assetDone(group) {
  const img = group.some((a) => a.path);
  return img && (group[0].type !== "character" || !!groupHold(group));
}
function assetWhy(group) {
  if (!group.some((a) => a.path)) return "No image yet";
  if (group[0].type === "character" && !groupHold(group)) return "No identity hold";
  return "Ready";
}
const TYPE_PLURAL = { character: "CHARACTERS", location: "LOCATIONS", prop: "PROPS" };
const TYPE_SHORT = { character: "CHR", location: "LOC", prop: "PRP" };
const typeLabel = (t) => TYPE_PLURAL[t] || `${String(t).toUpperCase()}S`;
function usedInShots(group) {
  const ids = new Set(group.map((a) => a.id));
  return (EP.shots || []).filter((s) => (s.refs || []).some((r) => ids.has(r)));
}
function setVaultView(v) { VAULT_VIEW = v; VAULT_SEL = null; try { localStorage.setItem("rcs-vault-view", v); } catch { /* ignore */ } renderEpisode(); }

function vaultStage() {
  // A (re)imported script changes what's missing.
  if (VAULT_AUDIT && VAULT_AUDIT._scenes !== (EP.scenes || []).length) VAULT_AUDIT = null;
  if (!VAULT_AUDIT) loadVaultAudit();
  const types = assetTypeOrder();
  if (!["script", "missing", "unfiled", ...types].includes(VAULT_VIEW)) VAULT_VIEW = types[0] || "character";
  const isType = types.includes(VAULT_VIEW);
  const wrap = el("div", isType ? "rc-board" : "rc-clips");
  wrap.append(vaultRail(types));
  if (isType) {
    const groups = groupAssets(EP.assets || []).filter((g) => g[0].type === VAULT_VIEW);
    if (!groups.some((g) => groupKey(g[0]) === VAULT_SEL)) VAULT_SEL = groups[0] ? groupKey(groups[0][0]) : null;
    wrap.append(vaultSheet(groups), vaultInspector(groups.find((g) => groupKey(g[0]) === VAULT_SEL)));
  } else {
    const page = el("div", "rc-page"); page.dataset.keepScroll = `vault-${VAULT_VIEW}`;
    const inner = el("div", "rc-pagein");
    if (VAULT_VIEW === "script") inner.append(setupView());
    else if (VAULT_VIEW === "missing") inner.append(missingView());
    else inner.append(unfiledView());
    page.append(inner);
    wrap.append(page);
  }
  return wrap;
}

async function loadVaultAudit() {
  try {
    const q = `dir=${encodeURIComponent(EP.dir)}${SERIES_DIR ? `&seriesDir=${encodeURIComponent(SERIES_DIR)}` : ""}`;
    VAULT_AUDIT = await api(`/api/episode/audit?${q}`);
    VAULT_AUDIT._scenes = (EP.scenes || []).length;
    if (IN_EPISODE && STAGE === "pre") renderEpisode();
  } catch { VAULT_AUDIT = { new: [], summary: { new: 0, standing: 0 }, failed: true }; }
}

function railItem({ short, title, a, b, lines = [], on, onClick, hint }) {
  const row = el("button", "rc-rl" + (on ? " on" : ""));
  if (hint) row.title = hint;
  const num = el("div", "num");
  num.innerHTML = `<b></b>${ringSvg(a, b)}`;
  num.querySelector("b").textContent = short;
  const body = el("div", "body");
  body.append(el("div", "hd", title), ...lines);
  row.append(num, body);
  row.onclick = onClick;
  return row;
}

function vaultRail(types) {
  const nav = el("nav", "rc-rail" + (RAIL_PINNED ? " pinned" : ""));
  const pin = el("button", "rc-pin", RAIL_PINNED ? "⇤ UNPIN" : "⇥ PIN");
  pin.onclick = () => { RAIL_PINNED = !RAIL_PINNED; saveShell(); nav.classList.toggle("pinned", RAIL_PINNED); pin.textContent = RAIL_PINNED ? "⇤ UNPIN" : "⇥ PIN"; };
  nav.append(pin);
  const nScenes = (EP.scenes || []).length;
  nav.append(railItem({
    short: "SET", title: "Setup & script", a: setupDoneCount(), b: 4, on: VAULT_VIEW === "script", onClick: () => setVaultView("script"),
    lines: [el("div", "rc-muted", EP.scriptPath ? `${EP.scriptPath.split("/").pop()} · ${nScenes} scenes` : "No script linked")],
  }));
  const miss = VAULT_AUDIT ? VAULT_AUDIT.new.length : null;
  const stand = VAULT_AUDIT ? VAULT_AUDIT.summary.standing : 0;
  nav.append(railItem({
    short: "MIS", title: "Missing from the vault", a: stand, b: miss == null ? 0 : stand + miss, on: VAULT_VIEW === "missing", onClick: () => setVaultView("missing"),
    hint: "What the script calls for that the series vault doesn't have yet",
    lines: [el("div", "rc-muted", miss == null ? "Checking the script…" : miss ? `${miss} the script needs` : "Nothing missing")],
  }));
  nav.append(railItem({
    short: "NEW", title: "Unfiled images", a: 0, b: 0, on: VAULT_VIEW === "unfiled", onClick: () => setVaultView("unfiled"),
    hint: "Images in the asset folders that no card uses yet — file or ignore",
    lines: [el("div", "rc-muted", "Not on any card yet")],
  }));
  const all = groupAssets(EP.assets || []);
  types.forEach((t) => {
    const gs = all.filter((g) => g[0].type === t);
    const withImg = gs.filter((g) => g.some((a) => a.path)).length;
    const withHold = gs.filter((g) => groupHold(g)).length;
    const lines = [meterRow("IMAGE", withImg, gs.length)];
    if (t === "character" || t === "location") lines.push(meterRow("HOLD", withHold, gs.length));
    nav.append(railItem({ short: TYPE_SHORT[t] || t.slice(0, 3).toUpperCase(), title: typeLabel(t).toLowerCase().replace(/^./, (c) => c.toUpperCase()), a: gs.filter(assetDone).length, b: gs.length, on: VAULT_VIEW === t, onClick: () => setVaultView(t), lines }));
  });
  nav.append(el("div", "rc-spacer"), el("div", "rc-legend", "RING = CARDS READY"));
  return nav;
}

function vaultSheet(groups) {
  const sec = el("section", "rc-sheet");
  sec.dataset.keepScroll = `vsheet-${VAULT_VIEW}`;
  const sh = el("div", "rc-sh");
  const ready = groups.filter(assetDone).length;
  const t = el("span"); t.append(el("b", null, typeLabel(VAULT_VIEW)), document.createTextNode(` · ${groups.length} CARDS · ${ready} READY`));
  sh.append(t);
  const right = el("span", "rc-shr");
  const add = el("button", "rc-btn", "+ NEW CARD");
  const form = el("div", "rc-newcard");
  form.style.display = "none";
  const nameI = Object.assign(document.createElement("input"), { placeholder: `Name of the new ${VAULT_VIEW}` });
  const scope = document.createElement("select");
  scope.className = "rc-scope";
  if (SERIES_DIR) scope.append(Object.assign(document.createElement("option"), { value: "series", textContent: "SERIES — EVERY EPISODE" }));
  scope.append(Object.assign(document.createElement("option"), { value: "episode", textContent: "THIS EPISODE ONLY" }));
  const ok = el("button", "rc-btn", "CREATE");
  const create = async () => {
    const name = nameI.value.trim();
    if (!name) { nameI.focus(); return; }
    try {
      await post("/api/episode/asset", { dir: EP.dir, asset: { type: VAULT_VIEW, name, fromSeries: scope.value === "series" } });
      VAULT_SEL = `${VAULT_VIEW}:${name.toLowerCase()}`;
      VAULT_OPEN.add("generate");
      await reloadEpisode();
    } catch (e) { fail(e); }
  };
  ok.onclick = create;
  nameI.onkeydown = (e) => { if (e.key === "Enter") create(); if (e.key === "Escape") form.style.display = "none"; };
  form.append(nameI, scope, ok);
  add.onclick = () => { form.style.display = form.style.display === "none" ? "" : "none"; if (form.style.display === "") nameI.focus(); };
  right.append(add);
  const local = groups.filter((g) => !g[0].fromSeries);
  if (SERIES_DIR && local.length) {
    const up = el("button", "rc-btn", `MOVE ${local.length} TO SERIES`);
    up.title = "Make these cards series cards, so every episode of the series has them";
    let armed = false;
    up.onclick = async () => {
      if (!armed) { armed = true; up.textContent = `CONFIRM · ${local.length} CARD${local.length === 1 ? "" : "S"} → SERIES`; up.classList.add("armed"); return; }
      try {
        const r = await post("/api/episode/asset/promote", { dir: EP.dir, assetIds: local.flat().map((a) => a.id) });
        await reloadEpisode();
        flashNote(`${local.length} card${local.length === 1 ? "" : "s"} (${r.promoted} image${r.promoted === 1 ? "" : "s"}) moved to the series vault.`);
      } catch (e) { fail(e); }
    };
    right.append(up);
  }
  sh.append(right);
  sec.append(sh, form);

  if (!groups.length) { sec.append(el("div", "rc-emptyst", `No ${typeLabel(VAULT_VIEW).toLowerCase()} yet. Add a card, or file one from Missing.`)); return sec; }
  const cells = el("div", "rc-cells vault");
  groups.forEach((g) => {
    const key = groupKey(g[0]);
    const c = el("button", "rc-cell" + (key === VAULT_SEL ? " sel" : ""));
    c.dataset.key = key;
    const h = el("div", "h");
    const angles = g.filter((a) => a.path).length;
    h.append(el("span", null, `${g[0].fromSeries ? "SERIES · " : ""}${angles > 1 ? `${angles} ANGLES` : angles ? "1 IMAGE" : "NO IMAGE"}`));
    const lamp = el("span", `rc-lamp ${assetDone(g) ? "ok" : "warn"}`); lamp.title = assetWhy(g); h.append(lamp);
    c.append(h);
    const rep = g.find((a) => a.path);
    if (rep) { const im = el("img"); im.loading = "lazy"; im.src = mediaURL(rep.path, 320); c.append(im); }
    else c.append(el("div", "noimg", "NO IMAGE"));
    c.append(el("div", "lbl", g[0].name));
    c.onclick = () => selectAsset(key);
    cells.append(c);
  });
  sec.append(cells);
  return sec;
}

function selectAsset(key) {
  VAULT_SEL = key;
  document.querySelectorAll(".rc-cell[data-key]").forEach((c) => c.classList.toggle("sel", c.dataset.key === key));
  const g = groupAssets(EP.assets || []).find((x) => groupKey(x[0]) === key);
  const old = document.querySelector(".rc-insp");
  if (old) old.replaceWith(vaultInspector(g));
  document.querySelector(".rc-cell.sel")?.scrollIntoView({ block: "nearest" });
}

function vaultInspector(group) {
  const a = el("aside", "rc-insp");
  a.dataset.keepScroll = "vinsp";
  if (!group) { a.append(el("div", "rc-emptyst", "Pick a card.")); return a; }
  const first = group[0], key = groupKey(first), type = first.type;
  const used = usedInShots(group);
  const h1 = el("div", "rc-h1");
  h1.append(el("span", null, `${type.toUpperCase()} · ${group.length} ANGLE${group.length === 1 ? "" : "S"}`), el("span", null, `USED IN ${used.length} SHOT${used.length === 1 ? "" : "S"}`));
  a.append(h1, el("h2", "rc-h2", first.name));
  if (SERIES_DIR) {
    const sc = el("div", "rc-scopeline" + (first.fromSeries ? " series" : ""));
    sc.append(el("span", null, first.fromSeries ? "SERIES CARD · EVERY EPISODE USES IT · EDITS APPLY TO ALL" : "EPISODE CARD · ONLY THIS EPISODE"));
    const btn = el("button", "rc-btn", first.fromSeries ? "MAKE EPISODE-ONLY" : "MOVE TO SERIES");
    btn.onclick = async () => {
      try {
        await post(`/api/episode/asset/${first.fromSeries ? "demote" : "promote"}`, { dir: EP.dir, assetIds: group.map((x) => x.id) });
        await reloadEpisode();
        flashNote(first.fromSeries ? "Now an episode card. The series keeps the name for Missing." : "Moved to the series vault — every episode of the series has it now.");
      } catch (e) { fail(e); }
    };
    sc.append(btn);
    a.append(sc);
  }

  const strip = el("div", "rc-angles");
  group.forEach((x) => {
    const f = el("figure");
    if (x.path) { const im = el("img"); im.src = mediaURL(x.path, 320); im.title = "Open full size"; im.onclick = () => window.open(mediaURL(x.path), "_blank"); f.append(im); }
    else {
      f.append(el("div", "none", "EMPTY"));
      // One click, as before the redesign: shots keep the card (server moves
      // their refs to another angle); undoable.
      if (group.length > 1) {
        const rm = el("button", "rc-slotx", "×");
        rm.title = "Remove this empty slot (shots keep the card)";
        rm.onclick = async () => { try { await post("/api/episode/asset/delete", { dir: EP.dir, assetId: x.id }); await reloadEpisode(); flashNote("Empty slot removed."); } catch (e) { fail(e); } };
        f.append(rm);
      }
    }
    f.append(el("figcaption", null, (x.angle || "main").toUpperCase()));
    strip.append(f);
  });
  a.append(strip);

  // Same pattern as the shot inspector: a sticky chip per section, CLOSE ALL,
  // and a close button at the end of each open section.
  const vSecBar = el("div", "rc-secbar");
  a.append(vSecBar);
  const vSecEls = {}, vChips = {};
  const syncVBar = () => Object.keys(vChips).forEach((k) => vChips[k].classList.toggle("on", !!(vSecEls[k] && vSecEls[k].open)));
  const sec = (k, title, meta, build) => {
    const d = el("details", "rc-sec");
    d.dataset.sec = k;
    d.open = VAULT_OPEN.has(k);
    d.ontoggle = () => { if (d.open) VAULT_OPEN.add(k); else VAULT_OPEN.delete(k); syncVBar(); };
    const sm = el("summary"); sm.append(el("span", null, title));
    const m = el("span", "meta"); if (meta) m.append(meta); sm.append(m);
    d.append(sm);
    const b = el("div", "rc-secb rc-legacy"); build(b);
    const cl = el("button", "rc-closesec", `▲ Close ${title.toLowerCase()}`);
    cl.onclick = () => { d.open = false; d.scrollIntoView({ block: "nearest" }); };
    b.append(cl);
    d.append(b);
    a.append(d);
    vSecEls[k] = d;
    const chip = el("button", "rc-chip", title.split(" · ")[0].split(" & ")[0]);
    chip.title = `Open or close ${title.toLowerCase()}`;
    chip.onclick = () => { d.open = !d.open; if (d.open) d.scrollIntoView({ block: "start", behavior: "smooth" }); };
    vChips[k] = chip; vSecBar.append(chip);
  };

  const empties = group.filter((x) => !x.path);
  sec("images", "ANGLES & IMAGES", empties.length ? el("span", "warn", `${empties.length} EMPTY`) : el("span", null, `${group.length}`), (b) => angleImages(b, group));

  const hold = groupHold(group);
  const holdName = type === "character" ? "IDENTITY HOLD" : "CONTINUITY HOLD";
  const holdMeta = hold ? el("span", null, "SET") : el("span", type === "character" ? "warn" : null, type === "character" ? "MISSING" : type === "location" ? "RECOMMENDED" : "OPTIONAL");
  sec("hold", holdName, holdMeta, (b) => holdEditor(b, group, key));
  sec("generate", "GENERATE", VAULT_RESULTS.get(key) && VAULT_RESULTS.get(key).length ? `${VAULT_RESULTS.get(key).length} TO FILE` : null, (b) => assetGenerator(b, group, key));
  sec("used", "USED IN SHOTS", String(used.length), (b) => {
    if (!used.length) { b.append(el("div", "rc-muted", "No shot references this card yet.")); return; }
    used.forEach((s) => {
      const r = el("button", "rc-usedrow");
      r.append(el("span", "c", shotCode(s)), el("span", "l", s.label || s.action || ""));
      r.onclick = () => { STAGE = "prod"; CUR_SCENE = String(s.sceneNum); SEL_SHOT = s.id; saveShell(); renderEpisode(); };
      b.append(r);
    });
  });
  sec("details", "DETAILS · EACH ANGLE", null, (b) => group.forEach((x) => {
    b.append(el("div", "rc-anglehd", (x.angle || "main").toUpperCase()));
    b.append(assetEditor(x, group));
  }));
  const vClose = el("button", "rc-chip rc-closeall", "CLOSE ALL");
  vClose.title = "Close every section on this card";
  vClose.onclick = () => { VAULT_OPEN.clear(); Object.values(vSecEls).forEach((d) => { d.open = false; }); syncVBar(); };
  vSecBar.append(vClose);
  syncVBar();
  return a;
}

// Add an angle (a face close-up, another outfit, a reverse view) or replace
// one angle's image, from your computer, this project, the generated inbox
// or a typed path. A new angle copies the card's hold, tags and scope.
function angleImages(b, group) {
  const first = group[0];
  b.append(el("div", "rc-note", "Each angle is one image of this card: a face close-up, another outfit, a reverse view. Shots using the card can send every angle."));
  const row = el("div", "rc-actions");
  const target = document.createElement("select");
  const empties = group.filter((x) => !x.path);
  target.append(Object.assign(document.createElement("option"), { value: "", textContent: "Add a new angle" }));
  group.forEach((x) => target.append(Object.assign(document.createElement("option"), { value: x.id, textContent: `${x.path ? "Replace" : "Fill"} image: ${(x.angle || "main")}` })));
  if (empties.length) target.value = empties[0].id;
  const angleI = Object.assign(document.createElement("input"), { placeholder: "Angle name, e.g. face close-up, outfit 2" });
  const syncAngle = () => { angleI.style.display = target.value ? "none" : ""; };
  target.onchange = syncAngle; syncAngle();
  row.append(target, angleI);
  b.append(row);
  const destSub = `02_assets/${first.type}s`;
  const attach = async (path_) => {
    if (target.value) {
      await post("/api/episode/asset/update", { dir: EP.dir, assetId: target.value, patch: { path: path_, file: path_.split("/").pop() } });
    } else {
      const angle = angleI.value.trim();
      if (!angle) { angleI.focus(); throw new Error("Name the new angle first (e.g. face close-up)."); }
      await post("/api/episode/asset", { dir: EP.dir, asset: { type: first.type, name: first.name, angle, path: path_, file: path_.split("/").pop(), identityHold: groupHold(group) || "", tags: first.tags || [], voice: first.voice || "", fromSeries: !!first.fromSeries } });
    }
    await reloadEpisode();
    flashNote(target.value ? "Image updated." : `Angle "${angleI.value.trim()}" added.`);
  };
  b.append(imageSourcePicker({
    onPickInbox: async (file) => {
      try {
        const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
        const angle = target.value ? (group.find((x) => x.id === target.value) || {}).angle : angleI.value.trim();
        const filename = `${slugify(first.name)}${angle ? `_${slugify(angle)}` : ""}.${ext}`;
        const { path: newPath } = await post("/api/media/promote", { source: file.name, fromInbox: true, dir: EP.dir, destSub, filename });
        await attach(newPath);
      } catch (e) { fail(e); }
    },
    onPickDirect: async (path_) => { try { await attach(path_); } catch (e) { fail(e); } },
    uploadDestSub: destSub,
  }));
}

function holdEditor(b, group, key) {
  const type = group[0].type;
  const advice = {
    character: "Recommended for every character. Added to every prompt this card feeds so the face, build, hair and signature wardrobe don't drift.",
    location: "Recommended for locations that recur. Keeps architecture, palette and light consistent between shots.",
  }[type] || "Optional. Worth it for hero props that appear in several shots.";
  b.append(el("div", "rc-note", advice));
  const kept = claudeAssetDraft("hold", group[0].id);
  const draft = VAULT_HOLDS.get(key) || kept;
  const dropKept = () => (kept ? claudeClear("assets", `hold:${group[0].id}`) : Promise.resolve());
  const ta = Object.assign(document.createElement("textarea"), { rows: 4, value: draft ? draft.text : groupHold(group) || group.map((a) => a.identityHold).find(Boolean) || "" });
  ta.placeholder = type === "character" ? "Keep this exact character: identical face, …" : `Keep this exact ${type}: …`;
  ta.oninput = () => VAULT_HOLDS.set(key, { text: ta.value, notes: (VAULT_HOLDS.get(key) || {}).notes || [] });
  b.append(ta);
  if (draft && draft.notes && draft.notes.length) {
    const n = el("div", "rc-claude-notes");
    n.append(el("div", "h", "CLAUDE'S NOTES"));
    draft.notes.forEach((t) => n.append(el("div", null, t)));
    b.append(n);
  }
  const row = el("div", "rc-actions");
  const save = el("button", "primary", "SAVE HOLD");
  save.onclick = async () => {
    try {
      for (const x of group) await post("/api/episode/asset/update", { dir: EP.dir, assetId: x.id, patch: { identityHold: ta.value.trim() } });
      VAULT_HOLDS.delete(key);
      await dropKept();
      PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`);
      await reloadEpisode();
      flashNote("Hold saved on every angle of this card.");
    } catch (e) { fail(e); }
  };
  const dr = claudeButton("DRAFT WITH CLAUDE", key, async () => {
    const r = await post("/api/episode/claude/asset", { dir: EP.dir, assetId: group[0].id, kind: "hold" });
    VAULT_HOLDS.set(key, { text: r.text, notes: r.notes });
    flashNote(`Draft ready — $${r.usd.toFixed(3)}. Edit, then Save.`);
  });
  row.append(save, dr);
  if (draft) {
    const discard = el("button", null, "DISCARD DRAFT");
    discard.onclick = async () => { VAULT_HOLDS.delete(key); try { await dropKept(); } catch (e) { fail(e); } renderEpisode(); };
    row.append(discard);
  }
  b.append(row);
}

// A Claude button that disables itself (with the reason) when Claude isn't set up.
function claudeButton(label, key, run) {
  const btn = el("button", null, VAULT_BUSY === key ? "WORKING…" : label);
  btn.disabled = VAULT_BUSY === key;
  llmInfo().then((L) => {
    if (!L.ready) { btn.disabled = true; btn.title = L.reason; return; }
    // Show what a draft costs before the click (same model the server uses).
    const m = (L.models || []).find((x) => x.id === L.default);
    if (m && VAULT_BUSY !== key) btn.textContent = `${label} · ~$${llmEstimate(m, "asset").toFixed(2)}`;
  }).catch(() => {});
  btn.onclick = async () => {
    VAULT_BUSY = key; renderEpisode();
    try { await run(); await reloadEpisode(); } catch (e) { fail(e); }
    finally { VAULT_BUSY = null; renderEpisode(); }
  };
  return btn;
}

const DEFAULT_ASSET_PROMPT = {
  character: (n) => `Character reference of ${n}: full figure, front view, neutral seamless backdrop, soft even light, no text.`,
  location: (n) => `Location plate of ${n}: wide establishing view, empty of people, natural light, no text.`,
  prop: (n) => `Prop reference of ${n}: the object alone, centred on a neutral backdrop, soft even light, no hands, no text.`,
};

function assetGenerator(b, group, key) {
  const first = group[0], type = first.type;
  const imgModels = (MODELS && MODELS.image) || [];
  if (!VAULT_IMG_MODEL || !imgModels.some((m) => m.id === VAULT_IMG_MODEL)) VAULT_IMG_MODEL = (imgModels.find((m) => m.id === STILL_MODEL_ID) || imgModels[0] || {}).id;
  const m = imgModels.find((x) => x.id === VAULT_IMG_MODEL);

  const keptP = claudeAssetDraft("prompt", first.id);
  const ta = Object.assign(document.createElement("textarea"), { rows: 4, value: VAULT_PROMPTS.get(key) ?? (keptP ? keptP.text : (DEFAULT_ASSET_PROMPT[type] || DEFAULT_ASSET_PROMPT.prop)(first.name)) });
  ta.oninput = () => VAULT_PROMPTS.set(key, ta.value);
  b.append(el("div", "rc-note", "The episode's global style, this card's hold and the ban list are added automatically."), ta);
  const notes = VAULT_PNOTES.get(key) || (keptP && keptP.notes);
  if (notes && notes.length) {
    const n = el("div", "rc-claude-notes"); n.append(el("div", "h", "CLAUDE'S NOTES")); notes.forEach((t) => n.append(el("div", null, t))); b.append(n);
  }

  const opts = el("div", "rc-genopts");
  const sel = document.createElement("select");
  imgModels.forEach((x) => { const o = document.createElement("option"); o.value = x.id; o.textContent = `${x.label} · $${Number(x.usdPerImage).toFixed(3)}/img`; if (x.id === VAULT_IMG_MODEL) o.selected = true; sel.append(o); });
  sel.onchange = () => { VAULT_IMG_MODEL = sel.value; renderEpisode(); };
  const nSel = document.createElement("select");
  [1, 2, 3, 4].forEach((n) => { const o = document.createElement("option"); o.value = n; o.textContent = `${n} variant${n === 1 ? "" : "s"}`; if (n === VAULT_N) o.selected = true; nSel.append(o); });
  nSel.onchange = () => { VAULT_N = Number(nSel.value); renderEpisode(); };
  opts.append(labeled("Model", sel), labeled("Variants", nSel));
  b.append(opts);

  const refs = group.filter((x) => x.path);
  const refCb = Object.assign(document.createElement("input"), { type: "checkbox", checked: refs.length > 0, disabled: !refs.length });
  const refL = el("label", "rc-check"); refL.append(refCb, document.createTextNode(refs.length ? ` Use this card's ${refs.length} image${refs.length === 1 ? "" : "s"} as reference` : " No images on this card to use as reference"));
  b.append(refL);
  if (m) {
    const est = el("div", "rc-est");
    est.append(el("span", null, `ESTIMATE · ${VAULT_N} × $${Number(m.usdPerImage).toFixed(3)}`), el("b", null, `$${(VAULT_N * m.usdPerImage).toFixed(2)}`), confTag(m.confidence));
    b.append(est);
  }

  const row = el("div", "rc-actions");
  const gen = el("button", "primary", VAULT_BUSY === key ? "GENERATING…" : "GENERATE");
  gen.disabled = VAULT_BUSY === key;
  gen.onclick = async () => {
    const prompt = ta.value.trim();
    if (!prompt) { fail(new Error("Write a prompt first (or draft one with Claude).")); return; }
    VAULT_PROMPTS.set(key, ta.value);
    VAULT_BUSY = key; renderEpisode();
    try {
      const r = await post("/api/episode/asset/generate", { dir: EP.dir, assetId: first.id, prompt, modelId: VAULT_IMG_MODEL, count: VAULT_N, refIds: refCb.checked ? refs.map((x) => x.id) : [] });
      VAULT_RESULTS.set(key, [...(VAULT_RESULTS.get(key) || []), ...r.paths]);
      if (keptP) await claudeClear("assets", `prompt:${first.id}`);
      await reloadEpisode();
    } catch (e) { fail(e); }
    finally { VAULT_BUSY = null; renderEpisode(); }
  };
  const dr = claudeButton("DRAFT PROMPT WITH CLAUDE", key, async () => {
    const r = await post("/api/episode/claude/asset", { dir: EP.dir, assetId: first.id, kind: "prompt", intent: ta.value !== (DEFAULT_ASSET_PROMPT[type] || DEFAULT_ASSET_PROMPT.prop)(first.name) ? ta.value : "" });
    VAULT_PROMPTS.set(key, r.text); VAULT_PNOTES.set(key, r.notes);
    flashNote(`Prompt drafted — $${r.usd.toFixed(3)}.`);
  });
  row.append(gen, dr);
  b.append(row);

  const results = VAULT_RESULTS.get(key) || [];
  if (results.length) {
    b.append(el("div", "rc-anglehd", "NEW — FILE THE KEEPERS"));
    const grid = el("div", "rc-results");
    const empties = group.filter((x) => !x.path);
    results.forEach((p) => {
      const f = el("figure");
      const im = el("img"); im.src = mediaURL(p, 320); im.onclick = () => window.open(mediaURL(p), "_blank"); f.append(im);
      const angleI = Object.assign(document.createElement("input"), { placeholder: "angle", value: type === "character" ? "front" : type === "location" ? "plate" : "" });
      const file = el("button", "rc-btn", empties.length ? `FILL ${(empties[0].angle || "MAIN").toUpperCase()}` : "ADD AS ANGLE");
      file.onclick = async () => {
        try {
          if (empties.length) await post("/api/episode/asset/update", { dir: EP.dir, assetId: empties[0].id, patch: { path: p, file: p.split("/").pop() } });
          else await post("/api/episode/asset", { dir: EP.dir, asset: { type, name: first.name, path: p, file: p.split("/").pop(), angle: angleI.value.trim(), identityHold: groupHold(group), tags: first.tags || [] } });
          VAULT_RESULTS.set(key, (VAULT_RESULTS.get(key) || []).filter((x) => x !== p));
          await reloadEpisode();
        } catch (e) { fail(e); }
      };
      const drop = el("button", "rc-btn", "DROP");
      drop.title = "Leave it out of the vault (the file stays in 02_assets/generated)";
      drop.onclick = () => { VAULT_RESULTS.set(key, (VAULT_RESULTS.get(key) || []).filter((x) => x !== p)); renderEpisode(); };
      const ctl = el("div", "ctl"); if (!empties.length) ctl.append(angleI); ctl.append(file, drop);
      f.append(ctl);
      grid.append(f);
    });
    b.append(grid);
  }
}

// What the script calls for that the vault lacks — each one a card in one click.
function missingView() {
  const c = el("div", "card");
  c.append(el("h2", null, "Missing from the vault"));
  c.append(Object.assign(el("div", "mini"), { textContent: "Characters, locations and props the script calls for that the series vault doesn't have yet. Create a card, then generate or attach its image." }));
  if (!VAULT_AUDIT) { c.append(el("div", "rc-muted", "Checking the script…")); return c; }
  if (!VAULT_AUDIT.new.length) c.append(el("div", "rc-emptyst", "Nothing missing — everything the script names has a card."));
  VAULT_AUDIT.new.forEach((row) => {
    const r = el("div", "rc-missrow");
    r.append(el("span", "t", row.type.toUpperCase()), el("span", "n", row.name));
    // "Serge" in the script may be "Serge Stitch" in the series: link it once,
    // series-wide, instead of creating a duplicate card.
    const same = (VAULT_AUDIT.registry || []).filter((x) => x.type === row.type);
    if (same.length && SERIES_DIR) {
      const sel = document.createElement("select");
      sel.className = "rc-same";
      sel.append(Object.assign(document.createElement("option"), { value: "", textContent: "SAME AS…" }));
      same.forEach((x) => sel.append(Object.assign(document.createElement("option"), { value: x.id, textContent: x.name })));
      sel.title = `Link "${row.name}" to an existing ${row.type} as another name for it (series-wide)`;
      sel.onchange = async () => {
        if (!sel.value) return;
        try {
          await post("/api/series/registry/alias", { seriesDir: SERIES_DIR, assetId: sel.value, alias: row.name });
          flashNote(`"${row.name}" now counts as ${same.find((x) => x.id === sel.value).name}.`);
          VAULT_AUDIT = null; renderEpisode();
        } catch (e) { fail(e); }
      };
      r.append(sel);
    }
    const mk = el("button", "rc-btn", "CREATE CARD");
    mk.onclick = async () => {
      try {
        // In a series it becomes a series card, which also clears it from Missing.
        await post("/api/episode/asset", { dir: EP.dir, asset: { type: row.type, name: row.name, fromSeries: !!SERIES_DIR } });
        VAULT_AUDIT = null; VAULT_VIEW = row.type; VAULT_SEL = `${row.type}:${row.name.trim().toLowerCase()}`; VAULT_OPEN.add("generate");
        await reloadEpisode();
      } catch (e) { fail(e); }
    };
    r.append(mk);
    c.append(r);
  });
  const more = el("details", "rc-sec");
  more.append(Object.assign(el("summary"), { textContent: "WAIVE OR REVIEW MATCHES" }));
  const mb = el("div", "rc-secb"); mb.append(auditBlock()); more.append(mb);
  c.append(more);
  return c;
}

// Images sitting in the asset folders that no card uses yet.
function unfiledView() {
  const c = el("div", "card");
  c.append(el("h2", null, "Unfiled images"));
  c.append(Object.assign(el("div", "mini"), { textContent: "Images in the series' asset folders that no card uses yet. Add each as a new card or as another angle on an existing one — or ignore it." }));
  c.append(Object.assign(el("div"), { id: "newImagesPanel" }));
  NEW_IMAGES_OPEN = true;
  queueMicrotask(() => renderNewImages(c));
  return c;
}

// ================= Post-production: the rough assembly =================
//
// Every shot in order. A shot with a selected take plays it (honouring the
// take's trim); a shot without one holds its storyboard frame for its target
// length. Day one it's an animatic; as takes land it becomes the rough cut.
// Same frame as the other stages: rail (scenes + sound & export) · viewer and
// filmstrip · inspector (the current shot's takes).

let POST_VIEW = "assembly";        // assembly | dialogue | sfx | roomtone | export | resolve
// [view, rail code, title, what it's for, rail line]
const POST_TOOLS = [
  ["dialogue", "DIA", "Dialogue", "Each spoken line: import or generate the voice, then place it on the shot.", "Voices per line"],
  ["sfx", "SFX", "Sound effects", "Effects per shot, generated or imported, laid under the cut.", "Effects per shot"],
  ["roomtone", "AMB", "Room tone", "A bed of ambience per scene so cuts don't drop to silence.", "Ambience per scene"],
  ["export", "EXP", "Timeline & export", "Build the timeline from selected takes, trim, then export FCPXML, OTIO or a CapCut sheet.", "FCPXML · OTIO · CapCut"],
  ["resolve", "RES", "From Resolve", "Bring a Resolve cut back: reorder shots to match it and see what audio it still needs.", "Round-trip a cut"],
];
let ASM_SCENE = "all";
const ASM = { items: [], idx: 0, offset: 0, playing: false, t0: 0, raf: 0, total: 0 };
const PX_PER_SEC = 16;

function primaryTake(shot) {
  const id = (shot.selectedVersions || [])[0];
  const v = (shot.versions || []).find((x) => x.id === id);
  return v && v.path && v.state === "done" ? v : null;
}
function boardSeconds(shot) {
  if (shot.remaster && shot.remaster.targetSeconds) return shot.remaster.targetSeconds;
  const p = (PROMPTS.shots || []).find((x) => x.id === shot.id);
  return (p && p.durationSec) || 3;
}
function buildAssembly(groups) {
  const items = [];
  groups.filter((g) => g.num !== CUT_SCENE && (ASM_SCENE === "all" || g.num === ASM_SCENE)).forEach((g) => g.shots.forEach((shot) => {
    const take = primaryTake(shot);
    if (take) {
      const tr = (shot.takeTrims || {})[take.id] || {};
      const inS = Number(tr.inSec) || 0;
      const outS = tr.outSec != null ? Number(tr.outSec) : null;
      const dur = outS != null ? outS - inS : Math.max(0.5, (Number(take.seconds) || 5) - inS);
      items.push({ kind: "clip", shot, scene: g.num, take, src: mediaURL(take.path), inS, outS, dur, thumb: shotThumb(shot) });
    } else items.push({ kind: "board", shot, scene: g.num, src: shotThumb(shot), dur: boardSeconds(shot), thumb: shotThumb(shot) });
  }));
  let t = 0;
  items.forEach((it) => { it.start = t; t += it.dur; });
  ASM.items = items; ASM.total = t;
  if (ASM.idx >= items.length) { ASM.idx = 0; ASM.offset = 0; }
}
const fmtTC = (s) => { s = Math.max(0, s || 0); const m = Math.floor(s / 60); return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(1).padStart(4, "0")}`; };

function postStage(groups) {
  ASM.playing = false; cancelAnimationFrame(ASM.raf);
  const wrap = el("div", POST_VIEW === "assembly" ? "rc-board post" : "rc-clips");
  wrap.append(postRail(groups));
  if (POST_VIEW !== "assembly") {
    const page = el("div", "rc-page"); page.dataset.keepScroll = `post-${POST_VIEW}`;
    const inner = el("div", "rc-pagein rc-legacy");
    const t = POST_TOOLS.find((x) => x[0] === POST_VIEW) || POST_TOOLS[0];
    const head = el("div", "rc-toolhead");
    head.append(el("h2", null, t[2]), el("div", "rc-note", t[3]));
    const card = el("div", "rc-toolbody");
    card.append(Object.assign(el("div"), { id: "postBody" }));
    inner.append(head, card);
    page.append(inner);
    wrap.append(page);
    loadPostProduction(card);
    return wrap;
  }
  buildAssembly(groups);
  wrap.append(assemblyMain(), assemblyInspector());
  queueMicrotask(() => asmLoad(ASM.idx, ASM.offset, false));
  return wrap;
}

function postRail(groups) {
  const nav = el("nav", "rc-rail" + (RAIL_PINNED ? " pinned" : ""));
  const pin = el("button", "rc-pin", RAIL_PINNED ? "⇤ UNPIN" : "⇥ PIN");
  pin.onclick = () => { RAIL_PINNED = !RAIL_PINNED; saveShell(); nav.classList.toggle("pinned", RAIL_PINNED); pin.textContent = RAIL_PINNED ? "⇤ UNPIN" : "⇥ PIN"; };
  nav.append(pin);
  const real = groups.filter((g) => g.num !== CUT_SCENE);
  const allShots = real.flatMap((g) => g.shots);
  const cut = (ss) => ss.filter((s) => primaryTake(s)).length;
  const go = (view, scene) => { POST_VIEW = view; if (scene) { ASM_SCENE = scene; ASM.idx = 0; ASM.offset = 0; } renderEpisode(); };
  nav.append(railItem({ short: "ALL", title: "Whole episode", a: cut(allShots), b: allShots.length, on: POST_VIEW === "assembly" && ASM_SCENE === "all", onClick: () => go("assembly", "all"), lines: [meterRow("CUT IN", cut(allShots), allShots.length)] }));
  real.forEach((g) => nav.append(railItem({
    short: String(g.num).padStart(2, "0"), title: sceneTitle(g), a: cut(g.shots), b: g.shots.length,
    on: POST_VIEW === "assembly" && ASM_SCENE === g.num, onClick: () => go("assembly", g.num),
    lines: g.shots.length ? [meterRow("CUT IN", cut(g.shots), g.shots.length)] : [el("div", "rc-muted", "No shots yet")],
  })));
  nav.append(el("div", "rc-railgap", "SOUND & DELIVERY"));
  POST_TOOLS.forEach(([id, short, title, , line]) => nav.append(railItem({ short, title, a: 0, b: 0, on: POST_VIEW === id, onClick: () => go(id), lines: [el("div", "rc-muted", line)] })));
  return nav;
}

function assemblyMain() {
  const main = el("section", "rc-asm");
  const head = el("div", "rc-sh");
  const nClip = ASM.items.filter((i) => i.kind === "clip").length;
  const t = el("span"); t.append(el("b", null, ASM_SCENE === "all" ? "ASSEMBLY" : `SC ${ASM_SCENE}`), document.createTextNode(` · ${ASM.items.length} SHOTS · ${nClip} CUT IN · ${ASM.items.length - nClip} BOARDS · ${fmtTC(ASM.total)}`));
  head.append(t);
  main.append(head);

  const view = el("div", "rc-viewer");
  const frame = el("div", "frame" + (EP.fmt === "16:9" ? " wide" : ""));
  const va = el("video"), vb = el("video");
  [va, vb].forEach((v) => { v.playsInline = true; v.preload = "auto"; v.className = "vid"; });
  const im = el("img", "board");
  const tag = el("div", "tag");
  frame.append(va, vb, im, tag);
  view.append(frame);
  main.append(view);

  const ctl = el("div", "rc-transport");
  const b = (txt, title, fn) => { const x = el("button", null, txt); x.title = title; x.onclick = fn; ctl.append(x); return x; };
  b("⏮", "Previous shot (←)", () => asmStep(-1));
  const play = b("▶", "Play / pause (space)", () => asmToggle());
  play.id = "asmPlay";
  b("⏭", "Next shot (→)", () => asmStep(1));
  const tc = el("span", "tc"); tc.id = "asmTC"; ctl.append(tc);
  const cur = el("span", "cur"); cur.id = "asmCur"; ctl.append(cur);
  main.append(ctl);

  const strip = el("div", "rc-strip");
  strip.id = "asmStrip";
  const track = el("div", "track");
  track.style.width = `${Math.max(1, ASM.total * PX_PER_SEC)}px`;
  let lastScene = null;
  ASM.items.forEach((it, i) => {
    const c = el("button", `it ${it.kind}`);
    c.style.left = `${it.start * PX_PER_SEC}px`; c.style.width = `${Math.max(2, it.dur * PX_PER_SEC - 2)}px`;
    if (it.thumb) c.style.backgroundImage = `url("${mediaURL(it.thumb, 120)}")`;
    c.title = `${shotCode(it.shot)} · ${it.kind === "clip" ? "take" : "board — no take yet"} · ${it.dur.toFixed(1)}s`;
    c.append(el("span", null, shotCode(it.shot)));
    c.onclick = (e) => { const r = c.getBoundingClientRect(); asmLoad(i, Math.max(0, (e.clientX - r.left) / PX_PER_SEC), ASM.playing); };
    track.append(c);
    if (it.scene !== lastScene) {
      const m = el("div", "scene", `SC ${it.scene}`); m.style.left = `${it.start * PX_PER_SEC}px`; track.append(m);
      lastScene = it.scene;
    }
  });
  const ph = el("div", "ph"); ph.id = "asmPH"; track.append(ph);
  strip.append(track);
  main.append(strip);
  return main;
}

function assemblyInspector() {
  const a = el("aside", "rc-insp");
  a.id = "asmInsp";
  return a;
}
function fillAsmInspector() {
  const a = document.getElementById("asmInsp");
  const it = ASM.items[ASM.idx];
  if (!a) return;
  a.replaceChildren();
  if (!it) { a.append(el("div", "rc-emptyst", "No shots in this view.")); return; }
  const shot = it.shot;
  const h1 = el("div", "rc-h1"); h1.append(el("span", null, `SHOT ${shotCode(shot)}`), el("span", null, `${it.dur.toFixed(1)}S · ${it.kind === "clip" ? "TAKE" : "BOARD"}`));
  a.append(h1, el("h2", "rc-h2", shot.label || shot.action || ""));
  const open = el("button", "rc-btn", "OPEN IN PRODUCTION →");
  open.onclick = () => { STAGE = "prod"; CUR_SCENE = String(shot.sceneNum); SEL_SHOT = shot.id; saveShell(); renderEpisode(); };
  a.append(open);
  a.append(el("div", "rc-anglehd", "TAKES — THE FIRST SELECTED ONE PLAYS"));
  const takes = (shot.versions || []).filter((v) => v.state === "done" && v.path);
  if (!takes.length) { a.append(el("div", "rc-muted", "No takes yet. The storyboard frame holds this slot.")); return; }
  const sel = shot.selectedVersions || [];
  takes.forEach((v) => {
    const r = el("div", "rc-takerow" + (sel[0] === v.id ? " on" : ""));
    const vid = el("video"); vid.src = `${mediaURL(v.path)}#t=0.5`; vid.muted = true; vid.preload = "metadata";
    vid.onmouseenter = () => vid.play().catch(() => {}); vid.onmouseleave = () => { vid.pause(); };
    const meta = el("div", "m");
    meta.append(el("div", "t", `${(v.modelLabel || v.modelId || "").replace(/^\d+[a-z]? - /i, "")}`), el("div", "d", `${Number(v.seconds) || "?"}s${sel.includes(v.id) ? (sel[0] === v.id ? " · PLAYING IN CUT" : " · SELECTED ALT") : ""}`));
    r.append(vid, meta);
    if (sel[0] !== v.id) {
      const use = el("button", "rc-btn", "USE");
      use.title = "Make this the take the assembly plays";
      use.onclick = async () => {
        try {
          // One call, one undo step: "primary" also selects a take that wasn't.
          await post("/api/episode/version/select", { dir: EP.dir, shotId: shot.id, versionId: v.id, action: "primary" });
          await reloadEpisode();
        } catch (e) { fail(e); }
      };
      r.append(use);
    }
    a.append(r);
  });
  // Trim the take the cut plays, right here: the assembly retimes on each mark.
  const playing = takes.find((v) => v.id === sel[0]);
  if (playing) {
    a.append(el("div", "rc-anglehd", "USABLE PART OF THE PLAYING TAKE"));
    const box = el("div", "rc-asmtrim rc-legacy");
    const vid = el("video");
    Object.assign(vid, { src: mediaURL(playing.path), controls: true, playsInline: true, preload: "metadata" });
    box.append(vid, takeMarkPanel({ ...playing, shotId: shot.id }, vid, () => { ASM.offset = 0; renderEpisode(); }));
    a.append(box);
  }
}

// ---------- the player ----------
const asmEls = () => {
  const f = document.querySelector(".rc-viewer .frame");
  if (!f) return null;
  const [va, vb] = f.querySelectorAll("video.vid");
  return { f, va, vb, im: f.querySelector("img.board"), tag: f.querySelector(".tag") };
};
let ASM_ACTIVE = 0;  // which <video> is live

function asmLoad(i, offset = 0, autoplay = false) {
  const E = asmEls();
  if (!E || !ASM.items.length) { fillAsmInspector(); asmPaint(); return; }
  i = Math.max(0, Math.min(ASM.items.length - 1, i));
  const it = ASM.items[i];
  const changed = i !== ASM.idx || !document.querySelector("#asmInsp").childElementCount;
  ASM.idx = i; ASM.offset = Math.min(offset, it.dur - 0.01);
  const vids = [E.va, E.vb];
  vids.forEach((v) => { v.pause(); });
  E.tag.textContent = it.kind === "board" ? `${shotCode(it.shot)} · BOARD — NO TAKE YET` : shotCode(it.shot);
  E.tag.className = `tag ${it.kind}`;
  if (it.kind === "clip") {
    E.im.style.display = "none";
    let v = vids[ASM_ACTIVE];
    // Use the preloaded element if it already holds this take.
    const other = vids[1 - ASM_ACTIVE];
    if (other.dataset.src === it.src) { ASM_ACTIVE = 1 - ASM_ACTIVE; v = other; }
    vids.forEach((x, k) => { x.style.display = k === ASM_ACTIVE ? "" : "none"; });
    if (v.dataset.src !== it.src) { v.src = it.src; v.dataset.src = it.src; }
    const seek = () => { try { v.currentTime = it.inS + ASM.offset; } catch { /* not ready */ } };
    if (v.readyState >= 1) seek(); else v.addEventListener("loadedmetadata", seek, { once: true });
    v.onloadedmetadata = () => {
      // Untrimmed take: its real length replaces the requested seconds.
      if (it.outS == null && Number.isFinite(v.duration) && Math.abs(v.duration - it.inS - it.dur) > 0.05) { it.dur = Math.max(0.5, v.duration - it.inS); asmRetime(); }
    };
  } else {
    vids.forEach((x) => { x.style.display = "none"; });
    E.im.style.display = "";
    if (it.src) E.im.src = mediaURL(it.src, 900); else E.im.removeAttribute("src");
  }
  asmPreloadNext();
  if (changed) fillAsmInspector();
  asmPaint();
  if (autoplay) asmPlay(); else { ASM.playing = false; asmButton(); }
}

function asmPreloadNext() {
  const E = asmEls(); if (!E) return;
  const nxt = ASM.items.slice(ASM.idx + 1).find((x) => x.kind === "clip");
  if (!nxt) return;
  const other = [E.va, E.vb][1 - ASM_ACTIVE];
  if (other.dataset.src !== nxt.src) { other.src = nxt.src; other.dataset.src = nxt.src; other.preload = "auto"; }
}

function asmPlay() {
  const E = asmEls(); const it = ASM.items[ASM.idx];
  if (!E || !it) return;
  ASM.playing = true; asmButton();
  ASM.t0 = performance.now() - ASM.offset * 1000;
  if (it.kind === "clip") [E.va, E.vb][ASM_ACTIVE].play().catch(() => {});
  cancelAnimationFrame(ASM.raf);
  ASM.raf = requestAnimationFrame(asmTick);
}
function asmPause() {
  const E = asmEls();
  ASM.playing = false; asmButton(); cancelAnimationFrame(ASM.raf);
  if (E) [E.va, E.vb].forEach((v) => v.pause());
}
const asmToggle = () => (ASM.playing ? asmPause() : (ASM.idx === ASM.items.length - 1 && ASM.offset >= ASM.items[ASM.idx].dur - 0.05 ? asmLoad(0, 0, true) : asmPlay()));
function asmStep(d) { asmLoad(ASM.idx + d, 0, ASM.playing); }
function asmButton() { const b = document.getElementById("asmPlay"); if (b) b.textContent = ASM.playing ? "❚❚" : "▶"; }

function asmTick() {
  const E = asmEls(); const it = ASM.items[ASM.idx];
  if (!E || !it || !ASM.playing) return;
  if (it.kind === "clip") {
    const v = [E.va, E.vb][ASM_ACTIVE];
    ASM.offset = Math.max(0, v.currentTime - it.inS);
    if (v.ended || ASM.offset >= it.dur - 0.04) return asmAdvance();
  } else {
    ASM.offset = (performance.now() - ASM.t0) / 1000;
    if (ASM.offset >= it.dur) return asmAdvance();
  }
  asmPaint();
  ASM.raf = requestAnimationFrame(asmTick);
}
function asmAdvance() {
  if (ASM.idx >= ASM.items.length - 1) { ASM.offset = ASM.items[ASM.idx].dur; asmPause(); asmPaint(); return; }
  asmLoad(ASM.idx + 1, 0, true);
}
function asmRetime() {
  let t = 0; ASM.items.forEach((x) => { x.start = t; t += x.dur; }); ASM.total = t;
  const track = document.querySelector("#asmStrip .track");
  if (!track) return;
  track.style.width = `${ASM.total * PX_PER_SEC}px`;
  const its = track.querySelectorAll(".it");
  ASM.items.forEach((x, k) => { if (its[k]) { its[k].style.left = `${x.start * PX_PER_SEC}px`; its[k].style.width = `${Math.max(2, x.dur * PX_PER_SEC - 2)}px`; } });
  let last = null, n = 0; const ms = track.querySelectorAll(".scene");
  ASM.items.forEach((x) => { if (x.scene !== last) { if (ms[n]) ms[n].style.left = `${x.start * PX_PER_SEC}px`; n++; last = x.scene; } });
}
function asmPaint() {
  const it = ASM.items[ASM.idx];
  const t = it ? it.start + ASM.offset : 0;
  const tc = document.getElementById("asmTC"); if (tc) tc.textContent = `${fmtTC(t)} / ${fmtTC(ASM.total)}`;
  const cur = document.getElementById("asmCur"); if (cur && it) cur.textContent = `${shotCode(it.shot)} · ${it.shot.label || ""}`;
  const ph = document.getElementById("asmPH"); if (ph) ph.style.left = `${t * PX_PER_SEC}px`;
  document.querySelectorAll("#asmStrip .it").forEach((c, k) => c.classList.toggle("on", k === ASM.idx));
  const strip = document.getElementById("asmStrip");
  if (strip) { const x = t * PX_PER_SEC; if (x < strip.scrollLeft + 40 || x > strip.scrollLeft + strip.clientWidth - 40) strip.scrollLeft = x - strip.clientWidth / 3; }
}

document.addEventListener("keydown", (e) => {
  if (!IN_EPISODE || STAGE !== "post" || POST_VIEW !== "assembly" || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  if (e.key === " ") { e.preventDefault(); asmToggle(); }
  else if (e.key === "ArrowRight") { e.preventDefault(); asmStep(1); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); asmStep(-1); }
  else if (e.key === "Home") { e.preventDefault(); asmLoad(0, 0, ASM.playing); }
});

// ================= New project + guided setup (step 4) =================

function newProjectForm() {
  const f = el("div", "card"); f.style.cssText = "margin:12px 0 0;background:var(--panel2)";
  const series = Object.assign(document.createElement("input"), { placeholder: "Series name, e.g. Fashion Heist" });
  const episode = Object.assign(document.createElement("input"), { placeholder: "Episode, e.g. S1E1", value: "S1E1" });
  const fmt = document.createElement("select");
  ["9:16", "16:9"].forEach((v) => fmt.append(Object.assign(document.createElement("option"), { value: v, textContent: v === "9:16" ? "9:16 vertical" : "16:9 widescreen" })));
  const style = Object.assign(document.createElement("input"), { placeholder: "Optional look, e.g. gritty period realism, filmic grade" });
  const g = el("div", "grid g3"); g.append(labeled("Series", series), labeled("Episode", episode), labeled("Format", fmt));
  const go = el("button", "primary", "Create and start setup");
  go.onclick = async () => {
    go.disabled = true;
    try {
      const r = await post("/api/project/create", { series: series.value, episode: episode.value, fmt: fmt.value, style: style.value });
      await openEpisode(r.dir, r.seriesDir);
    } catch (e) { fail(e); go.disabled = false; }
  };
  f.append(g, labeled("Global style", style));
  const row = el("div", "row"); row.style.marginTop = "10px"; row.append(go, Object.assign(el("span", "mini"), { textContent: "Creates the series folder and the episode's folders in your project root." }));
  f.append(row);
  return f;
}

function setupDoneCount() {
  const scenes = (EP.scenes || []).length;
  const groups = sceneGroups().filter((g) => g.num !== CUT_SCENE);
  const shotsDone = scenes && groups.filter((g) => g.scene).every((g) => g.shots.length);
  const missing = VAULT_AUDIT ? VAULT_AUDIT.new.length : 1;
  const vault = groupAssets(EP.assets || []);
  return [scenes > 0, !!shotsDone, scenes > 0 && missing === 0, vault.length > 0 && vault.every(assetDone)].filter(Boolean).length;
}

let SETUP_SERVICES = null;
let SETUP_RUN = null;   // { done, total, current } while breaking scenes down

async function loadServices() {
  try {
    LLM = null;
    const [h, L, v, c] = await Promise.all([api("/api/health"), llmInfo(), api("/api/voices").catch(() => ({ status: { ready: false, reason: "voices unavailable" } })), api("/api/connections")]);
    SETUP_SERVICES = { drivers: h.drivers || {}, llm: L, voices: v.status || {}, connections: c };
  } catch { SETUP_SERVICES = { failed: true }; }
  if (IN_EPISODE && STAGE === "pre" && VAULT_VIEW === "script") renderEpisode();
}

function setupStep(n, title, done, body, note) {
  const c = el("div", "rc-step" + (done ? " done" : ""));
  const h = el("div", "sh");
  h.append(el("span", "n", done ? "✓" : String(n)), el("span", "t", title));
  if (note) h.append(el("span", "note", note));
  c.append(h);
  const b = el("div", "sb"); body(b); c.append(b);
  return c;
}

let OPEN_SETUP_FOR = null; // episode dir to open on Setup once (a new remaster)

function setupView() {
  if (!SETUP_SERVICES) loadServices();
  const wrap = el("div", "rc-setup");
  wrap.append(el("h2", "rc-setup-h", "Set up this episode"));
  wrap.append(el("div", "rc-note", "Script in, shots drafted, cast and locations on cards. Each paid step shows its estimate before it runs."));

  // 0 · connections
  const conn = SETUP_SERVICES && SETUP_SERVICES.connections;
  const anyReady = conn && conn.providers.some((p) => p.ready);
  wrap.append(setupStep(0, "Connect services", !!(conn && ["aggregator", "llm"].every((c) => conn.providers.some((p) => p.category === c && p.ready))), (b) => {
    if (!conn) { b.append(el("div", "rc-muted", "Checking…")); return; }
    b.append(connectionsPanel(conn));
  }, anyReady ? null : "OPTIONAL FOR NOW"));

  // Remaster: what the cut kept, left out, and needs in sound.
  if (EP.remaster) {
    const lo = EP.remaster.leftOut || [];
    wrap.append(setupStep("C", "From the cut", !lo.length, (b) => {
      b.append(el("div", "rc-note", `This episode remasters your Resolve cut: ${(EP.shots || []).length} shots in cut order, each with a target length from the cut. Add back anything you want after all. In Production, each shot's REFERENCE VIDEO can send the part of its old take that made the cut.`));
      const legacy = el("div", "rc-legacy"); legacy.append(remasterInfo()); b.append(legacy);
    }, lo.length ? `${lo.length} LEFT OUT` : null));
  }

  // 1 · script
  const scenes = (EP.scenes || []).length;
  wrap.append(setupStep(1, "Script", scenes > 0, (b) => {
    if (scenes) b.append(el("div", "rc-ok", `${scenes} scenes imported${EP.scriptPath ? ` from ${EP.scriptPath.split("/").pop()}` : ""}.`));
    const up = el("div", "rc-upload");
    const file = Object.assign(document.createElement("input"), { type: "file", accept: ".fdx,.fountain,.txt" });
    file.style.display = "none";
    const pick = el("button", scenes ? null : "primary", scenes ? "UPLOAD A REVISED SCRIPT" : "UPLOAD SCRIPT (.fdx or .fountain)");
    pick.onclick = () => file.click();
    const st = el("span", "rc-muted");
    file.onchange = async () => {
      const f = file.files[0]; if (!f) return;
      st.textContent = `Uploading ${f.name}…`;
      try {
        const data = await f.arrayBuffer();
        let bin = ""; const bytes = new Uint8Array(data);
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        const { path: p } = await post("/api/media/upload", { dir: EP.dir, destSub: "00_script", filename: f.name, dataBase64: btoa(bin) });
        st.textContent = "Reading the script…";
        await parseScriptFile(dev, p);
        st.textContent = "Check the scenes below, then Import.";
      } catch (e) { st.textContent = ""; fail(e); }
    };
    up.append(pick, file, st);
    b.append(up);
    const dev = developmentPanel();
    dev.classList.add("rc-embed");
    const h2 = dev.querySelector("h2"); if (h2) h2.textContent = "Or pick a script already in the project folders";
    // Step 2 has the skeleton button; the old Hook/Cliffhanger gate fields are retired.
    [...dev.querySelectorAll("button")].find((x) => x.textContent.startsWith("Draft shot skeletons"))?.closest(".row")?.remove();
    [...dev.querySelectorAll("label.f > span")].find((x) => x.textContent.startsWith("Hook"))?.closest(".grid")?.remove();
    b.append(dev);
  }));

  // 2 · shots
  const groups = sceneGroups().filter((g) => g.num !== CUT_SCENE && g.scene);
  const empty = groups.filter((g) => !g.shots.length);
  wrap.append(setupStep(2, "Provisional shot list", scenes > 0 && !empty.length, (b) => {
    if (!scenes) { b.append(el("div", "rc-muted", "Import a script first.")); return; }
    b.append(el("div", "rc-note", `${groups.length - empty.length} of ${groups.length} scenes have shots. Claude reads each scene and proposes a shot list; you tick which shots to keep. Blank skeletons are free: one empty shot per scene to fill in yourself.`));
    const row = el("div", "rc-actions");
    if (empty.length) {
      const L = SETUP_SERVICES && SETUP_SERVICES.llm;
      const m = L && L.ready && (L.models || []).find((x) => x.id === (localPick("llm-shots") || L.default));
      const est = m ? empty.length * llmEstimate(m, "shots") : 0;
      const pending = empty.filter((g) => !claudeProposal(g));
      const run = el("button", "primary", SETUP_RUN ? `BREAKING DOWN ${SETUP_RUN.done + 1}/${SETUP_RUN.total}…`
        : !m ? "BREAK DOWN WITH CLAUDE · NOT CONNECTED"
        : `BREAK DOWN ${pending.length} SCENE${pending.length === 1 ? "" : "S"} WITH CLAUDE · ~$${est.toFixed(2)}`);
      run.disabled = !!SETUP_RUN || !m || !pending.length;
      if (!m) run.title = (L && L.reason) || "Claude isn't connected (step 0).";
      let armed = false;
      run.onclick = async () => {
        // Two clicks: the first shows the total, the second spends it.
        if (!armed) { armed = true; run.textContent = `CONFIRM · ${pending.length} × ${m.label} · ~$${(pending.length * llmEstimate(m, "shots")).toFixed(2)}`; run.classList.add("armed"); return; }
        SETUP_RUN = { done: 0, total: pending.length };
        renderEpisode();
        for (const g of pending) {
          try { await post("/api/episode/claude/shots", { dir: EP.dir, sceneNum: g.num, llm: m.id }); }
          catch (e) { fail(new Error(`Scene ${g.num}: ${e.message}`)); }
          SETUP_RUN.done++;
          EP = await api(`/api/episode?dir=${encodeURIComponent(EP.dir)}`);
          renderEpisode();
        }
        SETUP_RUN = null;
        await reloadEpisode();
        flashNote("Proposals ready — tick the shots to keep in each scene below.");
      };
      row.append(run);
      const blank = el("button", null, "BLANK SKELETONS (FREE)");
      blank.onclick = async () => {
        try { await post("/api/episode/shots/draft-from-scenes", { dir: EP.dir }); PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`); await reloadEpisode(); } catch (e) { fail(e); }
      };
      row.append(blank);
    }
    b.append(row);
    groups.forEach((g) => {
      const sc = el("div", "rc-scene-row");
      const prop = claudeProposal(g);
      sc.append(el("div", "hd", `${sceneHeading(g)} · ${g.shots.length ? `${g.shots.length} shots` : prop ? `${prop.shots.length} proposed — review` : "no shots"}`));
      if (prop || (!g.shots.length && SETUP_SERVICES && SETUP_SERVICES.llm && SETUP_SERVICES.llm.ready)) sc.append(claudeShotsTool(g));
      b.append(sc);
    });
  }));

  // 3 · cast & locations
  const miss = VAULT_AUDIT ? VAULT_AUDIT.new : null;
  wrap.append(setupStep(3, "Cast, locations & props", scenes > 0 && miss && !miss.length, (b) => {
    if (!scenes) { b.append(el("div", "rc-muted", "Import a script first.")); return; }
    if (!miss) { b.append(el("div", "rc-muted", "Checking what the script needs…")); return; }
    if (!miss.length) { b.append(el("div", "rc-ok", "Everything the script names has a card.")); return; }
    b.append(el("div", "rc-note", `The script names ${miss.length} character${miss.length === 1 ? "" : "s"}, location${miss.length === 1 ? "" : "s"} or prop${miss.length === 1 ? "" : "s"} the vault doesn't have. If one is just another name for an existing card ("Serge" for "Serge Stitch"), link it in Missing instead of creating a duplicate.`));
    const row = el("div", "rc-actions");
    const all = el("button", "primary", `CREATE ALL ${miss.length} CARDS`);
    all.onclick = async () => {
      all.disabled = true;
      try {
        for (const r of miss) {
          await post("/api/episode/asset", { dir: EP.dir, asset: { type: r.type, name: r.name, fromSeries: !!SERIES_DIR } });
        }
        VAULT_AUDIT = null;
        await reloadEpisode();
        flashNote(`${miss.length} cards created.`);
      } catch (e) { fail(e); all.disabled = false; }
    };
    const rev = el("button", null, "REVIEW IN MISSING");
    rev.onclick = () => setVaultView("missing");
    row.append(all, rev);
    b.append(row);
    b.append(el("div", "rc-muted", miss.map((r) => `${r.type}: ${r.name}`).join(" · ")));
  }));

  // 4 · images & holds
  const vault = groupAssets(EP.assets || []);
  const noImg = vault.filter((g) => !g.some((a) => a.path)).length;
  const noHold = vault.filter((g) => g[0].type === "character" && !groupHold(g)).length;
  wrap.append(setupStep(4, "Reference images & identity holds", vault.length > 0 && vault.every(assetDone), (b) => {
    if (!vault.length) { b.append(el("div", "rc-muted", "Create the cards first (step 3).")); return; }
    b.append(el("div", "rc-note", `${noImg} card${noImg === 1 ? "" : "s"} without an image · ${noHold} character${noHold === 1 ? "" : "s"} without an identity hold. Generate or attach images and draft holds on each card.`));
    const t = assetTypeOrder().find((x) => vault.some((g) => g[0].type === x && !assetDone(g))) || assetTypeOrder()[0];
    const go = el("button", "primary", `OPEN ${typeLabel(t)}`);
    go.onclick = () => setVaultView(t);
    b.append(go);
  }));

  const fin = el("div", "rc-actions");
  const prod = el("button", "primary", "GO TO PRODUCTION →");
  prod.onclick = () => goStage("prod");
  fin.append(prod);
  wrap.append(fin);
  return wrap;
}

// ================= Drag-and-drop reordering =================
//
// Shots: drag a frame onto another frame in the same scene; it lands before or
// after it (whichever half you drop on) and the scene re-letters. Scenes: drag
// a row in the scene rail; scenes renumber 1..n and carry their shots. Each is
// one server edit, so one ⌘Z undoes it.

let DRAG = null;   // { kind: "shot"|"scene", id }
const clearDropMarks = () => document.querySelectorAll(".drop-before,.drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after"));

function dragShot(cell, shot, g) {
  cell.draggable = true;
  cell.title = "Drag to reorder within the scene";
  cell.ondragstart = (e) => { DRAG = { kind: "shot", id: shot.id, scene: g.num }; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", shot.id); cell.classList.add("dragging"); };
  cell.ondragend = () => { cell.classList.remove("dragging"); clearDropMarks(); DRAG = null; };
  cell.ondragover = (e) => {
    if (!DRAG || DRAG.kind !== "shot" || DRAG.scene !== g.num || DRAG.id === shot.id) return;
    e.preventDefault();
    const r = cell.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    clearDropMarks(); cell.classList.add(after ? "drop-after" : "drop-before");
  };
  cell.ondragleave = () => cell.classList.remove("drop-before", "drop-after");
  cell.ondrop = async (e) => {
    e.preventDefault();
    if (!DRAG || DRAG.kind !== "shot" || DRAG.id === shot.id) return;
    const after = cell.classList.contains("drop-after");
    clearDropMarks();
    const moving = (EP.shots || []).find((s) => s.id === DRAG.id);
    const from = moving ? shotCode(moving) : "";
    const list = g.shots.filter((s) => s.id !== DRAG.id);
    const k = list.findIndex((s) => s.id === shot.id);
    const before = after ? (list[k + 1] ? list[k + 1].id : null) : shot.id;
    try {
      const r = await post("/api/episode/shot/reorder", { dir: EP.dir, shotId: DRAG.id, beforeShotId: before });
      PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`);
      await reloadEpisode();
      const now = (EP.shots || []).find((s) => s.id === (moving && moving.id));
      if (r.moved && now) flashNote(`${from} is now ${shotCode(now)} — scene ${g.num} re-lettered. ⌘Z undoes it.`);
    } catch (err) { fail(err); }
  };
}

// The Archive accepts a dragged shot from any scene (rail row, or the zone
// under a scene's shots). One server edit, so ⌘Z undoes it.
function archiveDropTarget(node) {
  node.addEventListener("dragover", (e) => {
    if (!DRAG || DRAG.kind !== "shot" || DRAG.scene === CUT_SCENE) return;
    e.preventDefault(); node.classList.add("drop-arch");
  });
  node.addEventListener("dragleave", () => node.classList.remove("drop-arch"));
  node.addEventListener("drop", async (e) => {
    e.preventDefault(); node.classList.remove("drop-arch");
    if (!DRAG || DRAG.kind !== "shot" || DRAG.scene === CUT_SCENE) return;
    const moving = (EP.shots || []).find((s) => s.id === DRAG.id);
    const from = moving ? shotCode(moving) : "";
    try {
      const r = await post("/api/episode/shot/move-to-scene", { dir: EP.dir, shotId: DRAG.id, targetSceneNum: CUT_SCENE, position: "end" });
      PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`);
      await reloadEpisode();
      flashNote(`${from} archived: out of the edit and every export${r.rebuilt ? " (timeline updated)" : ""}. Restore it from the Archive. ⌘Z undoes it.`);
    } catch (err) { fail(err); }
  });
}

function dragScene(row, g, groups) {
  row.draggable = true;
  row.ondragstart = (e) => { DRAG = { kind: "scene", id: g.num }; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", g.num); row.classList.add("dragging"); };
  row.ondragend = () => { row.classList.remove("dragging"); clearDropMarks(); DRAG = null; };
  row.ondragover = (e) => {
    if (!DRAG || DRAG.kind !== "scene" || DRAG.id === g.num) return;
    e.preventDefault();
    const r = row.getBoundingClientRect();
    clearDropMarks(); row.classList.add(e.clientY > r.top + r.height / 2 ? "drop-after" : "drop-before");
  };
  row.ondragleave = () => row.classList.remove("drop-before", "drop-after");
  row.ondrop = async (e) => {
    e.preventDefault();
    if (!DRAG || DRAG.kind !== "scene" || DRAG.id === g.num) return;
    const after = row.classList.contains("drop-after");
    clearDropMarks();
    const order = groups.map((x) => x.num).filter((n) => n !== CUT_SCENE && n !== DRAG.id);
    order.splice(order.indexOf(g.num) + (after ? 1 : 0), 0, DRAG.id);
    const moved = DRAG.id;
    const newNum = String(order.indexOf(moved) + 1);
    try {
      await post("/api/episode/scenes/reorder", { dir: EP.dir, order });
      PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`);
      CUR_SCENE = newNum;
      await reloadEpisode();
      flashNote(`Scene ${moved} is now scene ${newNum}; scenes renumbered with their shots. ⌘Z undoes it.`);
    } catch (err) { fail(err); }
  };
}

// ================= Reference video + blocking opt-in =================
//
// Motion references (Blender previs, grey-box, rehearsal clips) live in their
// own collapsible section between Storyboards and Generate. They join the
// prompt package only when switched on AND the shot's model takes reference
// video; then they show in the wiring summary like frames and references.

function shotVideoModel(shot) {
  const models = (MODELS && MODELS.video) || [];
  const sel = VIDEO_GEN_SEL.get(shot.id);
  return models.find((x) => x.id === ((sel && sel.modelId) || videoModelFor(shot, EP, models.map((m) => m.id)))) || null;
}
function shotRefVideoState(shot) {
  const m = shotVideoModel(shot);
  const all = shot.refVideos || [];
  const set = refVideoSet(shot, m && m.refVideo);
  const sending = set.videos;
  const poc = EP.remaster && shot.remaster && (shot.remaster.parts || []).length;
  const meta = !all.length ? (poc ? el("span", null, "PROOF OF CONCEPT AVAILABLE") : null) : sending.length ? el("span", "on", `${sending.length} IN PROMPT`) : el("span", null, `${all.length} CLIP${all.length === 1 ? "" : "S"} · NOT SENT`);
  return { model: m, all, sending, skipped: set.skipped, seconds: set.seconds || 0, meta };
}

function refVideoPanel(b, shot, rv) {
  b.append(el("div", "rc-note", "Blender previs, grey-box or a rehearsal clip. Sent as a motion reference: camera movement, staging and timing. The look still comes from the storyboards and the vault."));
  const m = rv.model;
  if (m && m.refVideo) {
    const L = m.refVideo;
    b.append(el("div", "rc-muted", `${m.label} takes up to ${L.max} clip${L.max === 1 ? "" : "s"}, ${L.minSec}–${L.maxSec} s each, ${L.totalSec} s combined · ~$${L.usdPerSec.toFixed(2)} per second of reference (estimated).`));
  } else {
    b.append(el("div", "rc-muted warn", `${m ? m.label : "This model"} doesn't take reference video. Choose "MiniMax H3 Max — references" or "Seedance 2.5 — references" in Generate to send these clips.`));
  }
  const skipWhy = new Map(rv.skipped.map((x) => [x.v.id, x.why]));
  rv.all.forEach((v) => {
    const r = el("div", "rc-rvrow" + (rv.sending.includes(v) ? " on" : ""));
    const vid = el("video"); vid.src = `${mediaURL(v.path)}#t=0.3`; vid.muted = true; vid.preload = "metadata"; vid.loop = true;
    vid.onmouseenter = () => vid.play().catch(() => {}); vid.onmouseleave = () => vid.pause();
    const meta = el("div", "m");
    const label = inlineEdit(v.label || "", async (val) => { await post("/api/episode/refvideo/update", { dir: EP.dir, shotId: shot.id, id: v.id, patch: { label: val } }); await reloadEpisode(); }, { placeholder: "label, e.g. Blender previs v2" });
    meta.append(label);
    const facts = [v.seconds ? `${Number(v.seconds).toFixed(1)} s` : "length unknown", v.width ? `${v.width}×${v.height}` : "", v.fps ? `${Math.round(v.fps)} fps` : ""].filter(Boolean).join(" · ");
    meta.append(el("div", "d", facts));
    if (v.use !== false && skipWhy.has(v.id)) meta.append(el("div", "d warn", `Not sent: ${skipWhy.get(v.id)}`));
    const ctl = el("div", "c");
    const use = Object.assign(document.createElement("input"), { type: "checkbox", checked: v.use !== false });
    const ul = el("label", "rc-check"); ul.append(use, document.createTextNode(" IN PROMPT"));
    use.onchange = async () => { try { await post("/api/episode/refvideo/update", { dir: EP.dir, shotId: shot.id, id: v.id, patch: { use: use.checked } }); PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`); await reloadEpisode(); } catch (e) { fail(e); } };
    const rm = el("button", "rc-btn", "REMOVE");
    rm.title = "Take it off this shot (the file stays in 02_assets/reference_video)";
    rm.onclick = async () => { try { await post("/api/episode/refvideo/remove", { dir: EP.dir, shotId: shot.id, id: v.id }); await reloadEpisode(); } catch (e) { fail(e); } };
    ctl.append(ul, rm);
    r.append(vid, meta, ctl);
    b.append(r);
  });
  const up = el("div", "rc-actions");
  const file = Object.assign(document.createElement("input"), { type: "file", accept: "video/mp4,video/quicktime,.mp4,.mov,.m4v" });
  file.style.display = "none";
  const btn = el("button", null, "+ UPLOAD REFERENCE VIDEO");
  const st = el("span", "rc-muted");
  btn.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files[0]; if (!f) return;
    st.textContent = `Uploading ${f.name} (${(f.size / 1e6).toFixed(1)} MB)…`; btn.disabled = true;
    try {
      const q = `dir=${encodeURIComponent(EP.dir)}&shotId=${encodeURIComponent(shot.id)}&filename=${encodeURIComponent(f.name)}`;
      const res = await fetch(`/api/episode/refvideo/upload?${q}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: f });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `upload failed (${res.status})`);
      INSP_OPEN.add("refvideo");
      PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`);
      await reloadEpisode();
    } catch (e) { fail(e); st.textContent = ""; btn.disabled = false; }
  };
  up.append(btn, file, st);
  b.append(up);
  if (EP.remaster && shot.remaster) b.append(cutPartsBox(shot));
}

// Remaster: the part of the proof-of-concept take that made the cut, offered
// as a reference clip. Off by default; switching it on trims it (ffmpeg, free)
// and adds it to the clips above, where it's sent like any other.
function cutPartsBox(shot) {
  const box = el("div", "rc-pocbox");
  box.append(el("div", "h", "FROM THE PROOF OF CONCEPT"));
  const list = el("div"); box.append(list);
  list.append(el("div", "rc-muted", "Reading the source take…"));
  api(`/api/episode/remaster/cut-parts?dir=${encodeURIComponent(EP.dir)}&shotId=${encodeURIComponent(shot.id)}`).then((info) => {
    list.innerHTML = "";
    if (!info.parts.length) {
      list.append(el("div", "rc-muted", info.addedBack ? "Added back from the source, so it has no part in the cut." : "No take of this shot is in the cut."));
      return;
    }
    list.append(el("div", "rc-muted", `The part of ${info.sourceCode}'s old take that made your cut. Switch one on to send it as a motion reference (trimmed here, free).`));
    info.parts.forEach((p) => {
      const r = el("div", "rc-rvrow" + (p.use ? " on" : ""));
      const vid = el("video"); vid.muted = true; vid.preload = "metadata";
      if (p.sourcePath) {
        vid.src = `${mediaURL(p.sourcePath)}#t=${p.srcIn},${p.srcOut}`;
        vid.onmouseenter = () => { vid.currentTime = p.srcIn; vid.play().catch(() => {}); };
        vid.ontimeupdate = () => { if (vid.currentTime >= p.srcOut) vid.currentTime = p.srcIn; };
        vid.onmouseleave = () => vid.pause();
      }
      const meta = el("div", "m");
      meta.append(el("div", null, `${fmtSec(p.srcIn)}–${fmtSec(p.srcOut)} of the take · ${p.seconds.toFixed(1)} s`));
      meta.append(el("div", "d", [p.modelId, p.onDisk ? "" : "take not on disk"].filter(Boolean).join(" · ")));
      const ctl = el("div", "c");
      const cb = Object.assign(document.createElement("input"), { type: "checkbox", checked: p.use, disabled: !p.onDisk && !p.refVideoId });
      const l = el("label", "rc-check"); l.append(cb, document.createTextNode(" USE AS REFERENCE"));
      cb.onchange = async () => {
        cb.disabled = true;
        if (cb.checked && !p.refVideoId) meta.append(el("div", "d", "Trimming…"));
        try {
          await post("/api/episode/remaster/cut-part", { dir: EP.dir, shotId: shot.id, index: p.index, use: cb.checked });
          INSP_OPEN.add("refvideo");
          PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`);
          await reloadEpisode();
        } catch (e) { cb.checked = !cb.checked; cb.disabled = false; fail(e); }
      };
      ctl.append(l);
      r.append(vid, meta, ctl);
      list.append(r);
    });
  }).catch((e) => { list.innerHTML = ""; list.append(el("div", "rc-muted warn", e.message)); });
  return box;
}

function blockingPromptToggle(shot) {
  const box = el("div", "rc-blkprompt");
  const cb = Object.assign(document.createElement("input"), { type: "checkbox", checked: !!shot.blockingInPrompt });
  const l = el("label", "rc-check"); l.append(cb, document.createTextNode(" Use this blocking in the prompt"));
  cb.onchange = async () => {
    try {
      await post("/api/episode/shot/update", { dir: EP.dir, shotId: shot.id, patch: { blockingInPrompt: cb.checked } });
      PROMPTS = await api(`/api/episode/prompts?dir=${encodeURIComponent(EP.dir)}`);
      await reloadEpisode(shot.id);
    } catch (e) { fail(e); }
  };
  box.append(l);
  const sentence = blockingSentence(shot.blocking);
  box.append(el("div", "rc-muted", sentence ? `${shot.blockingInPrompt ? "Adds" : "Would add"}: "${sentence}"` : "Place the characters and the camera below to get a blocking line for the prompt."));
  return box;
}

// ================= Connections + price watch =================

function connectionsPanel(conn) {
  const box = el("div", "rc-conn");
  conn.categories.forEach(([cat, title, blurb]) => {
    const g = el("div", "grp");
    g.append(el("div", "gh", title.toUpperCase()), el("div", "rc-muted", blurb));
    conn.providers.filter((p) => p.category === cat).forEach((p) => g.append(connectionRow(p)));
    box.append(g);
  });
  box.append(el("div", "rc-note", "Keys are saved in the app's own .env file on this computer and never shown again in full. Remove one any time; whatever it powered switches off."));
  return box;
}

function connectionRow(p) {
  const r = el("div", "rc-connrow" + (p.built ? "" : " soon"));
  r.append(el("span", `rc-lamp ${p.ready ? "ok" : p.connected ? "warn" : ""}`));
  const mid = el("div", "mid");
  const nm = el("div", "nm", p.name);
  if (p.keyUrl && p.built) { const a = Object.assign(el("a", "get", "GET A KEY ↗"), { href: p.keyUrl, target: "_blank", rel: "noopener noreferrer" }); nm.append(a); }
  mid.append(nm, el("div", "cv", p.covers || ""));
  if (p.connected || !p.built) mid.append(el("div", "st", p.connected ? `${p.masked} · ${p.note}` : p.note));
  r.append(mid);
  const act = el("div", "act");
  if (!p.built) act.append(el("span", "rc-muted", "SOON"));
  else if (p.connected) {
    const rm = el("button", "rc-btn", "REMOVE");
    let armed = false;
    rm.onclick = async () => {
      if (!armed) { armed = true; rm.textContent = "CONFIRM REMOVE"; rm.classList.add("armed"); return; }
      try { await post("/api/connections/remove", { id: p.id }); await afterConnectionChange(); } catch (e) { fail(e); }
    };
    act.append(rm);
  } else {
    const add = el("button", "rc-btn", "CONNECT");
    add.onclick = () => {
      act.replaceChildren();
      const inp = Object.assign(document.createElement("input"), { type: "password", placeholder: `${p.env}`, autocomplete: "off" });
      const save = el("button", "rc-btn primary", "SAVE");
      const cancel = el("button", "rc-btn", "×");
      save.onclick = async () => {
        try { await post("/api/connections/set", { id: p.id, key: inp.value }); inp.value = ""; await afterConnectionChange(); }
        catch (e) { fail(e); }
      };
      inp.onkeydown = (e) => { if (e.key === "Enter") save.onclick(); };
      cancel.onclick = () => afterConnectionChange();
      act.append(inp, save, cancel);
      inp.focus();
    };
    act.append(add);
  }
  r.append(act);
  return r;
}

async function afterConnectionChange() {
  LLM = null; SETUP_SERVICES = null;
  MODELS = await api("/api/models");
  if (IN_EPISODE) { renderEpisode(); loadServices(); }
}

async function fillPriceWatch(box) {
  box.replaceChildren(el("div", "rc-muted", "Checking prices…"));
  let st;
  try { st = await api("/api/prices"); } catch (e) { box.replaceChildren(el("div", "rc-muted warn", e.message)); return; }
  box.replaceChildren();
  const hd = el("div", "hd");
  const when = st.checkedAt ? new Date(st.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "never";
  hd.append(el("span", null, `PRICE WATCH · CHECKED ${when}`));
  const now = el("button", "rc-btn", "CHECK NOW");
  now.onclick = async (e) => {
    e.stopPropagation(); now.disabled = true; now.textContent = "CHECKING…";
    try { await api("/api/prices/check", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); MODELS = await api("/api/models"); renderEpisode(); } catch (err) { fail(err); }
  };
  hd.append(now);
  box.append(hd);
  (st.changes || []).forEach((c) => {
    const unit = c.kind === "image" ? "/img" : c.kind === "llm" ? "/M out" : "/s";
    box.append(el("div", `chg ${c.direction}`, `${c.direction === "down" ? "↓" : "↑"} ${c.label}: $${c.to.toFixed(3)}${unit}, was $${c.from.toFixed(3)} (${c.basis})`));
  });
  if (!(st.changes || []).length && st.checkedAt) box.append(el("div", "rc-muted", "No price changes since the last check."));
  (st.skipped || []).forEach((x) => box.append(el("div", "rc-muted", `Not checked: ${x}.`)));
  (st.errors || []).forEach((x) => box.append(el("div", "rc-muted warn", `Couldn't check ${x}`)));
  (st.unconverted || []).forEach((u) => box.append(el("div", "rc-muted", `${u.label}: fal lists $${u.unitPrice} per ${u.unit} — not converted to $/s, so its estimate stays on the table.`)));
  (st.unknown || []).forEach((u) => box.append(el("div", "rc-muted warn", `${u.label}: the provider didn't return a price for this model — check its endpoint name.`)));
}

// Once per change: a same-model price drop gets a one-line notice on opening an episode.
async function notifyPriceDrops() {
  let st; try { st = await api("/api/prices"); } catch { return; }
  let seen = []; try { seen = JSON.parse(localStorage.getItem("rcs-price-seen") || "[]"); } catch { /* ignore */ }
  const fresh = (st.changes || []).filter((c) => c.direction === "down" && !seen.includes(`${c.id}@${c.to}`));
  if (!fresh.length) return;
  const c = fresh[0];
  flashNote(`Price drop: ${c.label} $${c.to.toFixed(3)}${c.kind === "image" ? "/img" : "/s"}, was $${c.from.toFixed(3)}${fresh.length > 1 ? ` (+${fresh.length - 1} more in RATES)` : ""}.`);
  try { localStorage.setItem("rcs-price-seen", JSON.stringify([...seen, ...fresh.map((x) => `${x.id}@${x.to}`)].slice(-50))); } catch { /* ignore */ }
}
