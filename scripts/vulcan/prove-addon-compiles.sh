#!/usr/bin/env bash
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
echo "✅ addon compiles + server bound 127.0.0.1:$port on $GODOT_VERSION"

echo ">>> boot 3: the script validator on a class_name script (headless, no editor)"
kill "$GODOT_PID" 2>/dev/null || true
wait "$GODOT_PID" 2>/dev/null || true
GODOT_PID=""
printf 'class_name FixtureRegistered\nextends RefCounted\n\nfunc answer() -> int:\n\treturn 42\n' > "$proj/registered.gd"
printf 'class_name FixtureBroken\nextends RefCounted\n\nfunc broken( -> void:\n\tpass\n' > "$proj/broken.gd"
cat > "$proj/validate_probe.gd" <<'EOF'
extends SceneTree

func _initialize() -> void:
	var category = load("res://addons/mercury_vulcan/categories/script.gd")
	var ctx = load("res://addons/mercury_vulcan/core/context.gd").new()
	ctx.paths = load("res://addons/mercury_vulcan/core/paths.gd").new()
	var live = load("res://registered.gd")
	var live_id: int = live.get_instance_id()
	var by_path: Dictionary = category._validate({"path": "res://registered.gd"}, ctx)
	var by_content: Dictionary = category._validate({"content": FileAccess.get_file_as_string("res://registered.gd")}, ctx)
	var broken: Dictionary = category._validate({"path": "res://broken.gd"}, ctx)
	var live_after = load("res://registered.gd")
	var out := {
		"by_path_valid": by_path.get("ok", false) and by_path["result"].get("valid", false),
		"by_path_names_path": by_path.get("ok", false) and by_path["result"].get("path", "") == "res://registered.gd",
		"by_content_valid": by_content.get("ok", false) and by_content["result"].get("valid", false),
		"broken_invalid": broken.get("ok", false) and not broken["result"].get("valid", true),
		"broken_names_path": broken.get("ok", false) and broken["result"].get("path", "") == "res://broken.gd",
		"live_same_object": live_after.get_instance_id() == live_id,
		"live_still_answers": live_after.new().answer() == 42,
	}
	out["pass"] = out["by_path_valid"] and out["by_path_names_path"] and not out["by_content_valid"] and out["broken_invalid"] and out["broken_names_path"] and out["live_same_object"] and out["live_still_answers"]
	print(JSON.stringify(out))
	quit(0 if out["pass"] else 1)
EOF
"$GODOT" --editor --headless --path "$proj" --quit > "$work/import-fixture.log" 2>&1 || true
validate_rc=0
"$GODOT" --headless --path "$proj" --script res://validate_probe.gd > "$work/validate.log" 2>&1 || validate_rc=$?
verdict="$(grep -E '^\{' "$work/validate.log" | tail -1 || true)"
if [ "$validate_rc" != "0" ]; then
  echo "❌ prove-addon-compiles FAIL — the script validator on $GODOT_VERSION: ${verdict:-no verdict}"
  tail -25 "$work/validate.log"
  exit 1
fi
echo "✅ prove-addon-compiles PASS — validator leg: $verdict"
