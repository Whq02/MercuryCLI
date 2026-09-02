#!/usr/bin/env bash
set -u
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"

if [ "${RUN_LIVE:-}" != "1" ]; then
  echo ">>> validating the driver's own argument plumbing (no editor dialed)"
  "$bun" run "$here/live-godot-session-driver.ts" --mode plumbing || exit 1
  echo
  echo "live-godot-session-smoke: SKIP (plumbing GREEN) — to run the live journey arm:"
  echo "  · RUN_LIVE=1"
  echo "  · a Godot 4.x editor OPEN on the target project"
  echo "  · MERCURY_GODOT=1 (boot menu: miscellaneous > 'Godot language lanes')"
  echo "  · editor loopback listeners: LSP :6005 + DAP :6006 (Editor Settings > Network)"
  echo "  · optional VULCAN leg: MERCURY_GODOT_TOOLS=1 + addon installed (op:\"vulcan_install\") on :6010"
  echo "  · GODOT_PROJECT=<project dir> (or cd into it)"
  exit 0
fi

proj="${GODOT_PROJECT:-$PWD}"
if [ ! -f "$proj/project.godot" ]; then
  echo "live-godot-session-smoke: SKIP — no project.godot at '$proj' (set GODOT_PROJECT=<dir>)"
  exit 0
fi

echo ">>> live Godot IDE-session journey against $proj"
MERCURY_GODOT=1 "$bun" run "$here/live-godot-session-driver.ts" \
  --mode journey --project "$proj" \
  ${GODOT_SCENE:+--scene "$GODOT_SCENE"} \
  ${GODOT_GD:+--gd "$GODOT_GD"} \
  ${GODOT_BREAK_LINE:+--break-line "$GODOT_BREAK_LINE"}
