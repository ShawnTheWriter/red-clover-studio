#!/bin/bash
# Runs the server, and restarts it whenever it exits (a crash, an unhandled
# error). Started once by launch-app.sh and left running in the background;
# never invoked directly by a person.

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node || echo /usr/local/bin/node)"
LOG_FILE="/tmp/red-clover-studio.log"

cd "$PROJECT_DIR" || exit 1

fails=0
while true; do
  start=$(date +%s)
  "$NODE_BIN" server/index.js >>"$LOG_FILE" 2>&1
  end=$(date +%s)
  dur=$((end - start))
  echo "$(date): server exited after ${dur}s, restarting" >>"$LOG_FILE"

  # A restart that lasted only a few seconds is a real startup problem (a
  # syntax error, a missing dependency). Give up rather than spin forever
  # silently, and say so where Shawn will actually see it.
  if [ "$dur" -lt 3 ]; then
    fails=$((fails + 1))
    if [ "$fails" -ge 5 ]; then
      echo "$(date): failing within seconds of every start -- giving up" >>"$LOG_FILE"
      osascript -e "display alert \"Red Clover Studio keeps failing to start\" message \"Check $LOG_FILE for details.\" as critical"
      exit 1
    fi
  else
    fails=0
  fi
  sleep 2
done
