#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/utils/exitCliffDrain.ts src/utils/gracefulShutdown.ts
# gate-watch: src/utils/sessionStorage/writer.ts src/cli/print.ts
# gate-watch: src/query/scriptedStream.ts
# ============================================================================
# scripts/exit-handle/run-all.sh — the exit cliff (TASK-017
#  D3): what must LAND before process.exit. Globs prove-*.ts; auto-joins the
#  pooled gate.
#
#    prove-exit-cliff-drain.ts    the named drain's laws (pure): one bounded
#                                 grace · settled costs zero · never throws ·
#                                 in-flight lands · wedged abandoned by name ·
#                                 phases in data-dependency order · the
#                                 product seam registers (the transcript
#                                 writer, phase 1) and settles its flush
#    prove-exit-cliff-census.ts   the HANDLE CENSUS on the REAL dist: six -p
#                                 runs (a no-tool control · Read · Glob ·
#                                 Bash · Bash write · a denied Bash, the
#                                 scripted stream) leave ZERO pending
#                                 product-owned requests at the reallyExit
#                                 cliff and the transcript carries the final
#                                 turn after exit; the poison arm
#                                 (MERCURY_EXIT_CLIFF_DRAIN=0) shows the
#                                 pre-fix cut — the writer's append pending
#                                 at the cliff
#
#  Requires the prebuilt dist (the pooled gate prebuilds it).
# ============================================================================
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# exit-handle — the exit cliff drains by name"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
exit $fail
