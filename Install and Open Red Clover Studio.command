#!/bin/bash
# Double-click setup + launcher for people who don't use Terminal.
# First run: checks Node.js, installs the app's parts, starts it, opens the browser.
# Later runs: just starts it.
cd "$(dirname "$0")" || exit 1
say() { printf '\n%s\n' "$1"; }
stop_here() { say "$1"; printf '\nPress Return to close this window.'; read -r _; exit 1; }

say "Red Clover Studio"

# --- Node.js (22 or newer) ---
need_node() {
  say "Red Clover Studio needs a free program called Node.js (version 22 or newer)."
  say "I'm opening its download page. Download the LTS installer, run it, then double-click this file again."
  open "https://nodejs.org/en/download" 2>/dev/null
  stop_here "(Node.js isn't installed yet.)"
}
command -v node >/dev/null 2>&1 || need_node
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
[ "${NODE_MAJOR:-0}" -ge 22 ] 2>/dev/null || need_node

# --- ffmpeg (optional to start; needed for cutting, thumbnails, export) ---
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    say "Installing ffmpeg (video tools) with Homebrew. This can take a few minutes..."
    brew install ffmpeg || say "ffmpeg didn't install. The app will still open; see the README (Install) to add it later."
  else
    say "Heads-up: ffmpeg (video tools) isn't installed. The app opens without it, but trimming,"
    say "thumbnails and export won't work until you add it. See \"Install\" in the README."
  fi
fi

# --- the app's parts (first run only) ---
if [ ! -d node_modules ]; then
  say "First-time setup: installing the app's parts (about a minute)..."
  npm install --no-audit --no-fund || stop_here "Setup failed. Check your internet connection and double-click again."
fi

say "Starting Red Clover Studio. Your browser will open. Keep this window open while you work;"
say "close it (or press Control-C) to quit the app."
exec npm start
