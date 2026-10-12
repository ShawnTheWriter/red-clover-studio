#!/bin/bash
# Double-click launcher, as a plain .command file instead of an AppleScript
# applet. Finder runs a .command file directly in Terminal.app, which
# sidesteps the TCC ambiguity AppleScript's `do shell script` has around
# whether the OS attributes folder-access permission to the applet or to the
# shell it spawns (the actual cause of the Sep 2026 EPERM incident — see
# git log for the postmortem). Terminal.app is a stable, well-known grant
# target, so "Full Disk Access -> Terminal" covers this reliably.
exec "$(cd "$(dirname "$0")" && pwd)/launch-app.sh"
