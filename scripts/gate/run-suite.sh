#!/usr/bin/env bash
set -u

runner=$1
secs=$2
outdir=$3
note=${4:-}

dom=$(basename "$(dirname "$runner")")
out="$outdir/$dom.out"
repo_root=$(cd "$(dirname "$0")/../.." && pwd)
. "$repo_root/scripts/lib/suite-env.sh"
unset MERCURY_SUITE_TMPDIR
suite_scratch_init "$runner"

if [ -z "${MERCURY_CONFIG_DIR:-}" ]; then
  export MERCURY_CONFIG_DIR="$MERCURY_SUITE_TMPDIR/config-home"
  mkdir -p "$MERCURY_CONFIG_DIR"
  "${BUN:-$HOME/.bun/bin/bun}" run "$repo_root/scripts/lib/firstRunSeed.ts" "$MERCURY_CONFIG_DIR" "$repo_root"
fi

export MERCURY_HOME="${MERCURY_HOME:-$MERCURY_SUITE_TMPDIR/proof-home}"
mkdir -p "$MERCURY_HOME"

export BROWSER="${BROWSER:-/usr/bin/true}"

export MERCURY_CREDENTIAL_STORE="${MERCURY_CREDENTIAL_STORE:-file}"

. "$repo_root/scripts/lib/process-ledger.sh"
export MERCURY_PROCESS_LEDGER_DIR="$MERCURY_SUITE_TMPDIR/process-ledger"
mkdir -p "$MERCURY_PROCESS_LEDGER_DIR"

kill_tree() {
  local p=$1 c
  kill -STOP "$p" 2>/dev/null
  for c in $(pgrep -P "$p" 2>/dev/null); do kill_tree "$c"; done
  kill -9 "$p" 2>/dev/null
}

t0=$SECONDS
run_checked_suite() {
suite_class=$(sed -n 's/^# gate-class:[[:space:]]*//p' "$runner" 2>/dev/null | head -1 | tr -d '[:space:]')
case "$(uname -s)" in (MINGW* | MSYS* | CYGWIN*) posix_host=0 ;; (*) posix_host=1 ;; esac
if [ "$suite_class" = "pty" ] && [ "$posix_host" = 1 ] && [ -f "$repo_root/scripts/ui/vshot.py" ]; then
  capture_python="${MERCURY_PYTHON:-/usr/bin/python3}"
  if ! preflight_out=$("$capture_python" "$repo_root/scripts/ui/vshot.py" --preflight 2>&1); then
    {
      echo "capture preflight refused the suite before its first boot (interpreter $capture_python):"
      echo "$preflight_out"
    }
    return 78
  fi
fi
exec bash "$runner"
}
rm -f "$outdir/$dom.hang"
printf 'suite %s: proof run root %s (%s)\n' "$dom" "$MERCURY_SUITE_TMPDIR" "${MERCURY_SUITE_TMPDIR_NOTE:-}" >"$out"
python3 "$repo_root/scripts/lib/box_shape.py" --start "$outdir/$dom.start.json" "$secs" >>"$out" || exit 78
run_checked_suite >>"$out" 2>&1 &
pid=$!
runner=$$
end_suite_tree() {
  MERCURY_SUITE_BROWSER_CLEANER=1 "${MERCURY_NODE:-node}" "$repo_root/scripts/lib/proofBrowser.cjs" --quiesce "$pid" "$MERCURY_SUITE_TMPDIR" >>"$out" 2>&1
  kill_tree "$pid"
  wait "$pid" 2>/dev/null || true
  process_ledger_reap "$MERCURY_PROCESS_LEDGER_DIR" >>"$out" 2>&1
  suite_home_cleanup
}
( n=0; while [ "$n" -lt "$secs" ]; do sleep 1; n=$((n + 1)); kill -0 "$pid" 2>/dev/null || exit 0; kill -0 "$runner" 2>/dev/null || { printf '\n__SUITE_RUNNER_GONE (tree-killed)__\n' >>"$out"; end_suite_tree; exit 0; }; done; kill -0 "$pid" 2>/dev/null && { printf '\n__SUITE_TIMEOUT after %ss (tree-killed%s)__\n' "$secs" "${note:+; $note}" >>"$out"; echo "$secs" >"$outdir/$dom.hang"; end_suite_tree; } ) 2>/dev/null &
watcher=$!
on_runner_signal() {
  printf '\n__SUITE_RUNNER_SIGNALLED %s (tree-killed)__\n' "$1" >>"$out"
  end_suite_tree
  kill_tree "$watcher" 2>/dev/null
  exit "$2"
}
trap 'on_runner_signal TERM 143' TERM
trap 'on_runner_signal INT 130' INT
trap 'on_runner_signal HUP 129' HUP
wait "$pid" 2>/dev/null; rc=$?
if [ -f "$outdir/$dom.hang" ]; then wait "$watcher" 2>/dev/null; fi
suite_browser_cleanup >>"$out" 2>&1
process_ledger_reap "$MERCURY_PROCESS_LEDGER_DIR" >>"$out" 2>&1
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
suite_home_cleanup
echo "$rc" >"$outdir/$dom.rc.tmp" && mv -f "$outdir/$dom.rc.tmp" "$outdir/$dom.rc"
[ "$rc" -eq 255 ] && rc=254
exit "$rc"
