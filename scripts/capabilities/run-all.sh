#!/usr/bin/env bash
# gate-class: pure
# Capability Graduation Matrix — proof harness. Runs every
# scripts/capabilities/prove-*.ts via bun run; non-zero exit on any failure.
# The matrix-completeness proof keeps the capability matrix (a local document,
# never tracked — the proof says SKIPPED where it is absent) from silently
# rotting: every row must carry a verdict, a real source anchor, a
# flag/default, and a real proof file (or a parked/dead reason). New proofs are
# picked up by the glob; this suite auto-joins the green gate via
# scripts/run-all-suites.sh (globs */run-all.sh).
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Capability Graduation Matrix — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL CAPABILITY PROOFS PASS"; else echo "# ❌ SOME CAPABILITY PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
