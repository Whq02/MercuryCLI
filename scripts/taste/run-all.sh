#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/commands/good/index* src/commands/meh/index* src/commands/taste/runTaste*
# gate-watch: src/memdir/tasteLoop*
# Taste Loop (/meh, /good) — proof harness. Runs every scripts/taste/prove-*.ts
# via bun run; non-zero exit on any failure. New proofs are picked up by the glob.
# Auto-joins the green gate via scripts/run-all-suites.sh (globs */run-all.sh).
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Taste Loop — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL TASTE PROOFS PASS"; else echo "# ❌ SOME TASTE PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
