#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/compact/** src/run-core/turn-machine.ts
# gate-watch: src/tools/CheckpointTool/** src/tools/RewindTool/**
# ============================================================================
#  scripts/compact/run-all.sh — the context-maintenance proof suite (spec-07
#  estate): checkpoint/rewind verbs, the method ladder, projections.
#  Globs prove-*.ts; auto-joins the pool via scripts/run-all-suites.sh.
# ============================================================================
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# compact — context maintenance proofs"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
exit "$fail"
