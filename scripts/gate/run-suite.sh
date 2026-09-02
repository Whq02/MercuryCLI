#!/usr/bin/env bash
# ============================================================================
#  scripts/gate/run-suite.sh — run ONE domain suite under a watchdog.
#
#  The per-suite execution unit for scripts/run-all-suites.sh (the parallel
#  gate dispatches these through a bounded pool). Runs the given run-all.sh,
#  captures its combined output, enforces the per-suite budget with a full
#  process-tree kill, and leaves four artifacts for the parent:
#      $outdir/<dom>.out    combined stdout+stderr
#      $outdir/<dom>.rc     exit code (137 on tree-kill, like the old inline path)
#      $outdir/<dom>.secs   wall seconds (1s granularity, matching the old gate)
#      $outdir/<dom>.cpu    cpu seconds (user+sys) of the suite's waited
#                           process tree — the slot model's audit (a tree-
#                           killed orphan's time is not accounted; best-effort)
#  The .rc file is written LAST and ATOMICALLY (tmp+rename) — the parent
#  treats its presence as "done" and its content as a complete integer.
#
#  Usage: run-suite.sh <path/to/run-all.sh> <budget-secs> <outdir> [budget-note]
#  The optional note names the rule the budget came from; the timeout marker
#  carries it so a kill line explains itself.
#  Standalone-safe: bash scripts/gate/run-suite.sh scripts/ui/run-all.sh 300 /tmp/x
# ============================================================================
set -u

runner=$1
secs=$2
outdir=$3
note=${4:-}

dom=$(basename "$(dirname "$runner")")
out="$outdir/$dom.out"
repo_root=$(cd "$(dirname "$0")/../.." && pwd)

# HERMETIC HOME PIN (pinned home; re-cut
# gate proofs mix bun-run script writers with dist children, and
# an EXPLICIT MERCURY_CONFIG_DIR is the one value both sides obey. An
# inherited pin (a CI shard's ambient home, an operator's deliberate choice)
# is honoured as-is; a suite given no home gets its OWN per-suite scratch
# under $outdir, seeded through the ONE seeder (scripts/lib/firstRunSeed.ts:
# onboarded + trust for the checkout root) — never a directory that belongs
# to another program. Suites that isolate per-proof (mkdtemp
# MERCURY_CONFIG_DIR) still override per-process as before.
if [ -z "${MERCURY_CONFIG_DIR:-}" ]; then
  export MERCURY_CONFIG_DIR="$outdir/$dom.config-home"
  mkdir -p "$MERCURY_CONFIG_DIR"
  "${BUN:-$HOME/.bun/bin/bun}" run "$repo_root/scripts/lib/firstRunSeed.ts" "$MERCURY_CONFIG_DIR" "$repo_root"
fi

# HERMETIC MERCURY_HOME PIN (the boot-env leak — the
# MERCURY_DAEMON_DIR class): applyBootMenuEnv() reads the config home's
# boot-env.json (default ~/.mercury) in EVERY dist child, so an operator's
# saved enter-menu row (e.g. a THEMIS mode) silently flips flags inside any
# proof that spawns the binary and asserts flag-OFF behavior — "flag off"
# legs go RED the moment a real boot-env exists. Pin the gate to a per-suite
# empty home; suites that stage their own boot-env write into THIS dir (or
# export their own MERCURY_HOME) exactly as before. An inherited pin is
# honored.
export MERCURY_HOME="${MERCURY_HOME:-$outdir/$dom.proof-home}"
mkdir -p "$MERCURY_HOME"

# NO-BROWSER PIN: a proof-booted dist that reaches a
# logged-out login surface auto-opens the OAuth page in the OPERATOR'S real
# browser (services/oauth auto-open — correct interactively, hostile from a
# capture). openBrowser honors the standard BROWSER override; /usr/bin/true
# makes every proof-context open a no-op. Never overrides an explicit choice.
export BROWSER="${BROWSER:-/usr/bin/true}"

# Freeze-then-reap: STOP a node BEFORE enumerating its children — a suite that
# is actively forking can otherwise spawn into the pgrep→kill window and escape
# the reap (enumerate-then-kill TOCTOU). Every node is enumerated only after it
# is frozen, so the walk is complete by construction; SIGKILL lands bottom-up
# (SIGKILL is deliverable to a stopped process).
kill_tree() {
  local p=$1 c
  kill -STOP "$p" 2>/dev/null
  for c in $(pgrep -P "$p" 2>/dev/null); do kill_tree "$c"; done
  kill -9 "$p" 2>/dev/null
}

t0=$SECONDS
# The hang SIDECAR ($dom.hang) is the watchdog's own testimony — written only
# when THIS watchdog fires. Classifiers read it instead of scraping the
# marker text from the log: a suite that merely PRINTS the marker (the gate
# machinery self-test's synthetic estates do) is a red, never a hang.
rm -f "$outdir/$dom.hang"
bash "$runner" >"$out" 2>&1 &
pid=$!
( sleep "$secs"; kill -0 "$pid" 2>/dev/null && { printf '\n__SUITE_TIMEOUT after %ss (tree-killed%s)__\n' "$secs" "${note:+; $note}" >>"$out"; echo "$secs" >"$outdir/$dom.hang"; kill_tree "$pid"; } ) 2>/dev/null &
watcher=$!
wait "$pid" 2>/dev/null; rc=$?
# Children cpu (user+sys) accumulated into THIS shell by the wait above —
# `times` line 2 is the children's pair, "XmY.ZZZs XmY.ZZZs". The builtin
# runs in this shell (a command substitution would report its own empty
# subshell), its output parked in a file beside the other artifacts.
times >"$outdir/$dom.times"
cpu_secs=$(tail -1 "$outdir/$dom.times" | awk '{
  n = 0
  for (i = 1; i <= NF; i++) { m = $i; s = m; sub(/m.*/, "", m); sub(/.*m/, "", s); sub(/s$/, "", s); n += m * 60 + s }
  printf "%d", n + 0.5
}' 2>/dev/null)
case "$cpu_secs" in ('' | *[!0-9]*) cpu_secs=0 ;; esac
rm -f "$outdir/$dom.times"
# Reap the watcher AND its sleep child (the old inline gate orphaned the sleep).
kill_tree "$watcher" 2>/dev/null
wait "$watcher" 2>/dev/null

echo $(( SECONDS - t0 )) >"$outdir/$dom.secs"
echo "$cpu_secs" >"$outdir/$dom.cpu"
# .rc is the parent's "done" signal (presence ⇒ .out/.secs/.cpu complete) —
# publish it atomically so a parent poll can never read a torn/empty rc
# between the file's creation and its write (tmp+rename; the others need no
# rename because they are fully written before .rc appears).
echo "$rc" >"$outdir/$dom.rc.tmp" && mv -f "$outdir/$dom.rc.tmp" "$outdir/$dom.rc"
# xargs kills the whole pool on a 255 exit; the true rc lives in the .rc file.
[ "$rc" -eq 255 ] && rc=254
exit "$rc"
