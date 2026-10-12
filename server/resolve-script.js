// Scene bins in DaVinci Resolve, made by a Resolve script.
//
// Resolve ignores extra <event>s in an imported FCPXML (Shawn's test,
// 2026-10-07: everything landed in one bin), so the app writes a Lua script
// instead. Resolve runs it from Workspace > Scripts (internal scripting works
// in the free version; Lua is built in, Python would need its own install).
//
// The script carries a map of absolute file path -> bin name for every
// finished take in the episode, built from studio.json at the moment it is
// generated. It only creates bins and moves/imports clips in the CURRENT
// Resolve project's Media Pool; it never touches files or timelines.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readSettings } from "./settings.js";

// RCS_RESOLVE_SCRIPTS_DIR redirects it (tests and scratch servers), so a test
// run never adds entries to Shawn's real Workspace > Scripts menu.
export const RESOLVE_SCRIPTS_DIR = process.env.RCS_RESOLVE_SCRIPTS_DIR || readSettings().resolveScriptsDir
  || path.join(os.homedir(), "Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility");

export function binNameFor(ep, sceneNum) {
  const n = String(sceneNum);
  if (n === "X") return "Cut from edit";
  // The full slugline (INT./EXT. LOCATION - TIME). A scene without a heading
  // builds one from its own fields, then from its first shot's.
  const sc = (ep.scenes || []).find((s) => String(s.number) === n);
  let h = sc && sc.heading && sc.heading !== "(no slugline)" ? sc.heading.trim() : "";
  if (!h) {
    const src = (sc && sc.loc) ? sc : (ep.shots || []).find((x) => String(x.sceneNum) === n && x.loc);
    if (src) h = `${src.intext || "INT."} ${src.loc} - ${src.time || "DAY"}`.replace(/\s+/g, " ").trim();
  }
  return `Scene ${n}${h ? ` — ${h}` : ""}`;
}

// Lua long-bracket string: no escaping needed unless the text contains the
// closing bracket, in which case use a longer level.
function luaStr(s) {
  let eq = "=";
  while (String(s).includes(`]${eq}]`)) eq += "=";
  return `[${eq}[${s}]${eq}]`;
}

// takes: [{ abs, bin }] — every finished take with its bin. Order of `bins`
// is the order bins are created in (scene order, then Cut from edit).
export function buildSceneBinsLua({ episodeName, generatedAt, takes, bins, importAll }) {
  const mapLines = takes.map((t) => `  [ ${luaStr(t.abs)} ] = ${luaStr(t.bin)},`).join("\n");
  const byName = new Map();
  for (const t of takes) {
    const b = path.basename(t.abs);
    byName.set(b, byName.has(b) && byName.get(b) !== t.bin ? null : t.bin); // ambiguous names never match
  }
  const nameLines = [...byName].filter(([, v]) => v).map(([k, v]) => `  [ ${luaStr(k)} ] = ${luaStr(v)},`).join("\n");
  return `-- Red Clover Studio: scene bins for "${episodeName}"
-- Generated ${generatedAt} from studio.json. Re-generate it from the app after
-- shots move (Post-Production > From your Resolve cut).
-- What it does, in the CURRENT project only: makes one Media Pool bin per scene
-- (plus "Cut from edit") and moves each clip there by its file path.
${importAll ? "-- This version also IMPORTS every other finished take of each shot into its\n-- scene's bin, so alternates are at hand. Files and timelines are never changed." : "-- Files and timelines are never changed. Clips it doesn't recognise stay put."}

local IMPORT_ALL_TAKES = ${importAll ? "true" : "false"}

local BINS = {
${bins.map((b) => `  ${luaStr(b)},`).join("\n")}
}

local BY_PATH = {
${mapLines}
}

-- Fallback when Resolve reports a path in a different form: the file name,
-- only where it is unique to one bin.
local BY_NAME = {
${nameLines}
}

local function basename(p) return (p or ""):match("([^/]+)$") or p end

print("Red Clover: starting scene bins (${episodeName})")

local function main()
-- Menu scripts get a \`resolve\` global; the other two cover the Console and
-- older versions.
local app = resolve
if not app and Resolve then app = Resolve() end
if not app and bmd and bmd.scriptapp then app = bmd.scriptapp("Resolve") end
if not app then print("Red Clover: could not reach Resolve from this script.") return end
local project = app:GetProjectManager():GetCurrentProject()
if not project then print("Red Clover: open a project first.") return end
local mp = project:GetMediaPool()
local root = mp:GetRootFolder()

-- Resolve's Lua lists can carry non-object entries (a count, an index) next
-- to the items — Shawn's Resolve put a number in GetSubFolderList's table.
-- Keep only real Resolve objects, in index order.
local function items(t)
  local out = {}
  if type(t) ~= "table" then return out end
  local keys = {}
  for k, v in pairs(t) do
    if type(v) == "userdata" or type(v) == "table" then table.insert(keys, k) end
  end
  table.sort(keys, function(a, b)
    if type(a) == type(b) and (type(a) == "number" or type(a) == "string") then return a < b end
    return tostring(a) < tostring(b)
  end)
  for _, k in ipairs(keys) do table.insert(out, t[k]) end
  return out
end

local folders = {}
for _, f in ipairs(items(root:GetSubFolderList())) do folders[f:GetName()] = f end
local function bin(name)
  if not folders[name] then folders[name] = mp:AddSubFolder(root, name) end
  return folders[name]
end

-- Walk the whole Media Pool and decide where each known clip belongs.
local moves, present, unknown = {}, {}, 0
local function walk(folder)
  local here = folder:GetName()
  for _, clip in ipairs(items(folder:GetClipList())) do
    local p = clip:GetClipProperty("File Path")
    local target = BY_PATH[p] or BY_NAME[basename(p)]
    if target then
      present[p] = true
      present[basename(p)] = true
      if here ~= target then
        moves[target] = moves[target] or {}
        table.insert(moves[target], clip)
      end
    elseif p and p ~= "" then
      unknown = unknown + 1
    end
  end
  for _, sub in ipairs(items(folder:GetSubFolderList())) do walk(sub) end
end
walk(root)

local total = 0
for _, name in ipairs(BINS) do
  local list = moves[name]
  if list and #list > 0 then
    if mp:MoveClips(list, bin(name)) then
      print(string.format("Red Clover: %d clip(s) -> %s", #list, name))
      total = total + #list
    else
      print("Red Clover: could not move clips into " .. name)
    end
  end
end

local imported = 0
if IMPORT_ALL_TAKES then
  for _, name in ipairs(BINS) do
    local paths = {}
    for p, b in pairs(BY_PATH) do
      if b == name and not present[p] and not present[basename(p)] then table.insert(paths, p) end
    end
    if #paths > 0 then
      table.sort(paths)
      mp:SetCurrentFolder(bin(name))
      local got = items(mp:ImportMedia(paths))
      imported = imported + #got
      print(string.format("Red Clover: imported %d take(s) into %s", #got, name))
    end
  end
  mp:SetCurrentFolder(root)
end

print(string.format("Red Clover: done. Moved %d, imported %d, left %d clip(s) it doesn't know.", total, imported, unknown))
end

local ok, err = pcall(main)
if not ok then print("Red Clover: ERROR " .. tostring(err)) end
`;
}

// Build both scripts for an episode. `exists(abs)` filters out takes whose
// file is gone, so the import version never asks Resolve for a missing file.
export async function sceneBinScripts(ep, root, { exists }) {
  const takes = [];
  const used = new Set();
  for (const s of ep.shots || []) {
    const binName = binNameFor(ep, s.sceneNum);
    for (const v of s.versions || []) {
      if (v.state !== "done" || !v.path) continue;
      const abs = path.isAbsolute(v.path) ? v.path : path.join(root, v.path);
      if (!(await exists(abs))) continue;
      takes.push({ abs, bin: binName });
      used.add(binName);
    }
  }
  const sceneNums = [...new Set((ep.shots || []).map((s) => String(s.sceneNum)))]
    .sort((a, b) => (a === "X") - (b === "X") || Number(a) - Number(b));
  const bins = sceneNums.map((n) => binNameFor(ep, n)).filter((b) => used.has(b));
  const common = { episodeName: ep.name || "", generatedAt: new Date().toISOString().slice(0, 16).replace("T", " "), takes, bins };
  return {
    plain: buildSceneBinsLua({ ...common, importAll: false }),
    withTakes: buildSceneBinsLua({ ...common, importAll: true }),
    bins: bins.map((b) => ({ name: b, takes: takes.filter((t) => t.bin === b).length })),
  };
}

export async function writeSceneBinScripts(ep, root, epDirAbs) {
  const exists = (p) => fs.access(p).then(() => true, () => false);
  const { plain, withTakes, bins } = await sceneBinScripts(ep, root, { exists });
  const tag = path.basename(epDirAbs).replace(/[\/:]+/g, "-");
  const files = {
    [`Red Clover - Scene bins (${tag}).lua`]: plain,
    [`Red Clover - Scene bins + all takes (${tag}).lua`]: withTakes,
  };
  const keep = path.join(epDirAbs, "05_delivery", "resolve-scripts");
  await fs.mkdir(keep, { recursive: true });
  let installed = true;
  try { await fs.mkdir(RESOLVE_SCRIPTS_DIR, { recursive: true }); } catch { installed = false; }
  for (const [name, text] of Object.entries(files)) {
    await fs.writeFile(path.join(keep, name), text, "utf8");
    if (installed) await fs.writeFile(path.join(RESOLVE_SCRIPTS_DIR, name), text, "utf8").catch(() => { installed = false; });
  }
  return { names: Object.keys(files), installed, installedIn: RESOLVE_SCRIPTS_DIR, copyIn: keep, bins };
}
