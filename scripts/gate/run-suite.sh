#!/usr/bin/env bash
set -u

runner=$1
secs=$2
outdir=$3
note=${4:-}

dom=$(basename "$(dirname "$runner")")
out="$outdir/$dom.out"
repo_root=$(cd "$(dirname "$0")/../.." && pwd)

if [ -z "${MERCURY_CONFIG_DIR:-}" ]; then
  export MERCURY_CONFIG_DIR="$outdir/$dom.config-home"
  mkdir -p "$MERCURY_CONFIG_DIR"
  "${BUN:-$HOME/.bun/bin/bun}" run "$repo_root/scripts/lib/firstRunSeed.ts" "$MERCURY_CONFIG_DIR" "$repo_root"
fi

export MERCURY_HOME="${MERCURY_HOME:-$outdir/$dom.proof-home}"
mkdir -p "$MERCURY_HOME"

export BROWSER="${BROWSER:-/usr/bin/true}"

kill_tree() {
  local p=$1 c
  kill -STOP "$p" 2>/dev/null
  for c in $(pgrep -P "$p" 2>/dev/null); do kill_tree "$c"; done
  kill -9 "$p" 2>/dev/null
}

t0=$SECONDS
rm -f "$outdir/$dom.hang"
bash "$runner" >"$out" 2>&1 &
pid=$!
( sleep "$secs"; kill -0 "$pid" 2>/dev/null && { printf '\n__SUITE_TIMEOUT after %ss (tree-killed%s)__\n' "$secs" "${note:+; $note}" >>"$out"; echo "$secs" >"$outdir/$dom.hang"; kill_tree "$pid"; } ) 2>/dev/null &
watcher=$!
wait "$pid" 2>/dev/null; rc=$?
times >"$outdir/$dom.times"
cpu_secs=$(tail -1 "$outdir/$dom.times" | awk '{
  n = 0
  for (i = 1; i <= NF; i++) { m = $i; s = m; sub(/m.*/, "", m); sub(/.*m/, "", s); sub(/s$/, "", s); n += m * 60 + s }
  printf "%d", n + 0.5
}' 2>/dev/null)
case "$cpu_secs" in ('' | *[!0-9]*) cpu_secs=0 ;; esac
rm -f "$outdir/$dom.times"
kill_tree "$watcher" 2>/dev/null
wait "$watcher" 2>/dev/null

echo $(( SECONDS - t0 )) >"$outdir/$dom.secs"
echo "$cpu_secs" >"$outdir/$dom.cpu"
echo "$rc" >"$outdir/$dom.rc.tmp" && mv -f "$outdir/$dom.rc.tmp" "$outdir/$dom.rc"
[ "$rc" -eq 255 ] && rc=254
exit "$rc"
