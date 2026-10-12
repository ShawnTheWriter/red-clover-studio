// Per-user settings, outside the repo and outside any project:
//   ~/.red-clover-studio/settings.json   { projectRoot, resolveScriptsDir }
// (RCS_SETTINGS_FILE overrides the location — tests use a temp file.)
//
// Precedence everywhere: an environment variable (RCS_PROJECT_ROOT,
// RCS_RESOLVE_SCRIPTS_DIR — scratch servers and tests) wins over this file,
// and this file wins over the built-in default. No path of anyone's machine
// lives in the code (GitHub prep, 2026-10-12).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SETTINGS_FILE = process.env.RCS_SETTINGS_FILE || path.join(os.homedir(), ".red-clover-studio", "settings.json");

export function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) || {}; } catch { return {}; }
}

export function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  for (const k of Object.keys(next)) if (next[k] == null || next[k] === "") delete next[k];
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// What a new user is offered on first run.
export const SUGGESTED_ROOT = path.join(os.homedir(), "Red Clover Projects");
