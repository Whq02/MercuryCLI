#!/usr/bin/env bash
# capture.sh — render the enter-screen splash in a real PTY (vshot pyte
# pipeline) and emit a PNG for visual verification against the logo reference.
# Usage: capture.sh [cols] [rows] [out.png]
set -u
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
cols="${1:-120}"; rows="${2:-44}"; out="${3:-/tmp/splash-$cols.png}"
cfg="/tmp/splash-vshot-$cols.json"
grid="/tmp/splash-grid-$cols.json"
cat > "$cfg" <<EOF
{"argv":["node","$repo/assets/splash/mercury-splash.mjs"],"cols":$cols,"rows":$rows,"total":10,"out":"$grid"}
EOF
MERCURY_SPLASH_ONESHOT=1 /usr/bin/python3 "$repo/scripts/ui/vshot.py" "$cfg" >/dev/null 2>&1 || { echo "vshot failed"; exit 1; }
"$bun" -e "import { gridToPng } from '$repo/scripts/ui/gridToPng.ts'; await gridToPng('$grid', '$out'); console.log('$out')"
