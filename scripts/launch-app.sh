#!/bin/bash
# Starts the Red Clover Studio dev server if it isn't already running, then
# opens it in Google Chrome. Run via "Red Clover Studio.command" in Terminal.app --
# the Dock app (scripts/build-launcher-app.sh) hands off to Terminal rather
# than running this itself, because only Terminal has Full Disk Access to the
# Google Drive project root.
#
# The server runs under scripts/watchdog.sh, which restarts it if it exits.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=8099
URL="http://localhost:$PORT"
LOG_FILE="/tmp/red-clover-studio.log"

is_up() {
  curl -s -o /dev/null -m 2 "$URL"
}

if ! is_up; then
  nohup "$PROJECT_DIR/scripts/watchdog.sh" >>"$LOG_FILE" 2>&1 &

  # Wait up to ~20s for the server to come up before giving up.
  up=0
  for _ in $(seq 1 40); do
    if is_up; then
      up=1
      break
    fi
    sleep 0.5
  done

  if [ "$up" -ne 1 ]; then
    osascript -e "display alert \"Red Clover Studio failed to start\" message \"Check $LOG_FILE for details.\" as critical"
    exit 1
  fi
fi

# Chrome if it is installed, otherwise the default browser.
open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL"
