#!/bin/sh
# Wraps test/export.mjs so `npm test` gets full OTIO round-trip coverage when
# the local venv exists, and still runs (FCPXML/xmllint coverage only) when it
# doesn't — a missing optional dev dependency should never break the suite.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENV_PY="$DIR/.otio-venv/bin/python"
if [ -x "$VENV_PY" ]; then
  RCS_OTIO_PYTHON="$VENV_PY" node "$DIR/test/export.mjs"
else
  echo "note: .otio-venv not found — OTIO round-trip check will be skipped."
  echo "      Set it up once with: python3 -m venv .otio-venv && .otio-venv/bin/pip install opentimelineio"
  node "$DIR/test/export.mjs"
fi
