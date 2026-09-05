#!/usr/bin/env bash
set -euo pipefail

if [ "${RUN_LIVE:-}" != "1" ]; then
  echo "live-vulcan-smoke: SKIP (set RUN_LIVE=1 with a godot binary to run)"
  exit 0
fi
GODOT="${GODOT_BIN:-godot}"
if ! command -v "$GODOT" >/dev/null 2>&1; then
  echo "live-vulcan-smoke: SKIP — no godot binary ('$GODOT' not found; brew install godot / GODOT_BIN=…)"
  exit 0
fi

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"

echo ">>> stage 1: the GDScript compilation floor"
bash "$here/prove-addon-compiles.sh"

SMOKE_PORT=$((27000 + $$ % 1000))
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ! (echo > "/dev/tcp/127.0.0.1/$SMOKE_PORT") 2>/dev/null; then break; fi
  SMOKE_PORT=$((SMOKE_PORT + 1))
done
export MERCURY_GODOT_TOOLS_PORT="$SMOKE_PORT"
echo ">>> smoke port: $SMOKE_PORT"
work="$(mktemp -d "${TMPDIR:-/tmp}/vulcan-smoke-XXXXXX")"
proj="$work/game"
mkdir -p "$proj"
cat > "$proj/project.godot" <<EOF
config_version=5

[application]

config/name="vulcan-smoke"

[network]

debug/remote_port=$((SMOKE_PORT + 1))
EOF

smoke_ok=0
cleanup() {
  [ -n "${GODOT_PID:-}" ] && kill "$GODOT_PID" 2>/dev/null || true
  if [ "$smoke_ok" = "1" ]; then
    rm -rf "$work"
  else
    echo "live-vulcan-smoke: FAILED — workdir preserved for diagnosis: $work (editor.log inside)"
  fi
}
trap cleanup EXIT

echo ">>> installing the addon into the fixture project"
MERCURY_GODOT_TOOLS=1 "$bun" run "$here/smoke-driver.ts" install "$proj"

echo ">>> booting the headless editor (first boot imports, second serves)"
"$GODOT" --editor --headless --path "$proj" --quit >/dev/null 2>&1 || true
"$GODOT" --editor --headless --path "$proj" >"$work/editor.log" 2>&1 &
GODOT_PID=$!

LEGS="${LIVE_LEGS:-drive game}"
for leg in $LEGS; do
  case "$leg" in
    drive) echo ">>> driving the live loop" ;;
    game) echo ">>> driving the fixture game through the play-mode bridge" ;;
    *) echo "live-vulcan-smoke: unknown leg '$leg' (LIVE_LEGS takes drive and/or game)"; exit 2 ;;
  esac
  MERCURY_GODOT_TOOLS=1 "$bun" run "$here/smoke-driver.ts" "$leg" "$proj"
done

smoke_ok=1
echo "✅ live vulcan smoke PASS"
