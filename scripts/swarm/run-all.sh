#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/tools/TeamBriefTool/TeamBriefTool* src/utils/**
# Swarm coordination governance — proof harness (SendMessage governance pure
# functions + Q&A ledger, honesty-gated handoffs, TeamBrief aggregation seams).
# Runs every scripts/swarm/prove-*.ts via bun run; non-zero exit on any failure.
# New proofs are picked up by the glob; run-all-suites.sh globs this suite in.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# swarm governance — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL SWARM PROOFS PASS"; else echo "# ❌ SOME SWARM PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
