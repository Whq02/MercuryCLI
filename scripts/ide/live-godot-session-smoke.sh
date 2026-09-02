#!/usr/bin/env bash
# live-godot-session-smoke — the machine-dependent Godot IDE-session journey
# (RUN_LIVE=1 only — the live-clangd/live-vulcan precedent,
# NEVER part of the deterministic gate; run-all.sh only globs prove-*.ts).
#
# Journey: identify project → the fused session projection (LSP/DAP/VULCAN
# truth) → symbols via the mercury-godot LSP lane → run a scene via the
# `godot` DAP adapter ({project, scene, playArgs}) → breakpoint stop →
# stack/variables → VULCAN runtime tree IF armed → stop → the projection
# reflects the finished session.
#
# Machine prerequisites (the LOUD-skip list):
#   · RUN_LIVE=1
#   · a real Godot 4.x editor RUNNING with the target project open
#   · MERCURY_GODOT=1 (boot menu: miscellaneous > "Godot language lanes")
#     — the smoke arms it for its own process below
#   · editor listeners on the loopback ports: LSP :6005 + DAP :6006
#     (Editor Settings > Network; MERCURY_GODOT_LSP_PORT/_DAP_PORT override)
#   · optional VULCAN leg: MERCURY_GODOT_TOOLS=1 + the mercury_vulcan addon
#     installed + enabled (op:"vulcan_install"), listener on :6010
#   · GODOT_PROJECT=<dir> (or run from inside the project)
#
# Even without an editor this script validates its own argument plumbing
# (driver --mode plumbing) and exits 0 with the loud skip.
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
# The smoke arms the language lanes for its own process (the consent surface
# for a persistent arm stays the boot menu); VULCAN is NOT auto-armed — the
# operator arms MERCURY_GODOT_TOOLS deliberately (arming shifts behavior).
MERCURY_GODOT=1 "$bun" run "$here/live-godot-session-driver.ts" \
  --mode journey --project "$proj" \
  ${GODOT_SCENE:+--scene "$GODOT_SCENE"} \
  ${GODOT_GD:+--gd "$GODOT_GD"} \
  ${GODOT_BREAK_LINE:+--break-line "$GODOT_BREAK_LINE"}
