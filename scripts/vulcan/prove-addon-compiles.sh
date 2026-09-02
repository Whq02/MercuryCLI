#!/usr/bin/env bash
# prove-addon-compiles — the GDScript compilation floor (machine-gated leg).
# Boots the REAL headless editor on a scratch fixture project with the addon
# installed and FAILS if any script error names mercury_vulcan, or if the
# VULCAN server never binds its port (a plugin that compiles but never serves
# is the same broken product). GDScript compilation is only provable by the
# engine — the pure suite (run-all.sh) cannot see this class, which is how a
# strictness break shipped undetected; this leg is the close, wherever a
# binary exists. live-vulcan-smoke.sh runs it as stage one.
#
# Needs a godot 4.x binary on PATH or GODOT_BIN. SKIPs honestly otherwise.
set -euo pipefail

GODOT="${GODOT_BIN:-godot}"
if ! command -v "$GODOT" >/dev/null 2>&1; then
  echo "prove-addon-compiles: SKIP — no godot binary ('$GODOT' not found; set GODOT_BIN=…)."
  echo "  note: any current 4.x proves this leg; latest stable observed 4.7.2 (godotengine.org archive, 2026-08-22)."
  exit 0
fi
GODOT_VERSION="$("$GODOT" --version 2>/dev/null | tail -1 || true)"

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
work="$(mktemp -d "${TMPDIR:-/tmp}/vulcan-compile-XXXXXX")"
proj="$work/game"
mkdir -p "$proj"

# Scratch port so parallel lanes/suites on one machine never collide.
port=$((26000 + $$ % 1000))
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ! (echo > "/dev/tcp/127.0.0.1/$port") 2>/dev/null; then break; fi
  port=$((port + 1))
done

cat > "$proj/project.godot" <<EOF
config_version=5

[application]

config/name="vulcan-compile-floor"
EOF

GODOT_PID=""
cleanup() {
  if [ -n "$GODOT_PID" ]; then
    kill "$GODOT_PID" 2>/dev/null || true
    wait "$GODOT_PID" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

echo ">>> installing the addon into the fixture (port $port)"
# The installer syncs the project's mercury_vulcan/port setting to Mercury's
# configured port — the scratch port rides the same seam production uses.
MERCURY_GODOT_TOOLS=1 MERCURY_GODOT_TOOLS_PORT="$port" "$bun" run "$here/smoke-driver.ts" install "$proj" >/dev/null

echo ">>> boot 1: import pass"
"$GODOT" --editor --headless --path "$proj" --quit > "$work/import.log" 2>&1 || true

echo ">>> boot 2: serving pass (waiting for the VULCAN server to bind)"
"$GODOT" --editor --headless --path "$proj" > "$work/editor.log" 2>&1 &
GODOT_PID=$!

bound=0
for _ in $(seq 1 60); do
  if (echo > "/dev/tcp/127.0.0.1/$port") 2>/dev/null; then bound=1; break; fi
  if ! kill -0 "$GODOT_PID" 2>/dev/null; then break; fi
  sleep 1
done

# Give the log a beat to flush, then collect script errors naming the addon.
sleep 1
errors="$(grep -A2 -E 'SCRIPT ERROR|ERROR: Failed to load script' "$work/import.log" "$work/editor.log" 2>/dev/null | grep -i 'mercury_vulcan' || true)"

if [ -n "$errors" ]; then
  echo "❌ prove-addon-compiles FAIL — the addon does not compile on $GODOT_VERSION:"
  grep -B1 -A2 -E 'SCRIPT ERROR|ERROR: Failed to load script' "$work/import.log" "$work/editor.log" | head -60
  exit 1
fi
if [ "$bound" != "1" ]; then
  echo "❌ prove-addon-compiles FAIL — no script errors, but the VULCAN server never bound 127.0.0.1:$port on $GODOT_VERSION"
  echo "--- editor.log tail ---"
  tail -30 "$work/editor.log"
  exit 1
fi
echo "✅ prove-addon-compiles PASS — addon compiles + server bound 127.0.0.1:$port on $GODOT_VERSION"
