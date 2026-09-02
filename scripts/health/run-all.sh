#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/cli/healthJson* src/services/dap/dapClient* src/services/run/ownerLifecycle*
# gate-watch: src/substrate/startupMenu* src/utils/**
# /health certificate — proof harness (docs/HEALTH-CERTIFICATE.md).
# Runs every scripts/health/prove-*.ts via bun run; non-zero exit on any
# failure. New proofs are picked up by the glob; the suite itself auto-joins
# the green gate via scripts/run-all-suites.sh's scripts/*/run-all.sh glob.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# /health certificate — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL HEALTH PROOFS PASS"; else echo "# ❌ SOME HEALTH PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
