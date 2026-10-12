#!/bin/bash
# Builds /Applications/Red Clover Studio.app -- the Dock launcher.
#
# The applet never starts the server itself. When the server isn't up, it
# hands "Red Clover Studio.command" to Terminal.app, so Terminal is the process
# macOS holds responsible for the server. Terminal has Full Disk Access; the
# ad-hoc-signed applet does not, and the Sep 2026 EPERM incident was exactly
# that: the applet ran launch-app.sh via `do shell script`, and every server it
# spawned was refused read access to the Google Drive project root.
#
# If the server is already running, the applet just opens it in Google Chrome and no
# Terminal window appears.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="/Applications/Red Clover Studio.app"
COMMAND_FILE="$PROJECT_DIR/scripts/Red Clover Studio.command"
ICON="$PROJECT_DIR/branding/RedCloverStudio.icns"
URL="http://localhost:8099"

SRC=$(mktemp -t rcs-launcher).applescript
cat >"$SRC" <<APPLESCRIPT
try
	do shell script "curl -s -o /dev/null -m 2 $URL"
	do shell script "open -a 'Google Chrome' $URL"
on error
	do shell script "open -a Terminal " & quoted form of "$COMMAND_FILE"
end try
APPLESCRIPT

rm -rf "$APP"
osacompile -o "$APP" "$SRC"
cp "$ICON" "$APP/Contents/Resources/applet.icns"
rm -f "$APP/Contents/Resources/Assets.car"   # else it overrides applet.icns
codesign --force --sign - "$APP"
touch "$APP"                                   # nudge Finder/Dock icon cache
rm -f "$SRC"
echo "Built $APP"
