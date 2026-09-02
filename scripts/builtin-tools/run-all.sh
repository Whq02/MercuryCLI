#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/Tool* src/ink/** src/services/changeTransaction/contracts*
# gate-watch: src/services/gitGraph/observe* src/services/gitGraph/plan*
# gate-watch: src/services/journeys/runner* src/services/primitives/**
# gate-watch: src/services/resources/adapters/** src/services/resources/registry*
# gate-watch: src/services/run/resolveOwner* src/services/structure/** src/substrate/flagRegistry*
# gate-watch: src/tools/** src/utils/capability/**
# the tool-capability
# proof harness: census drift gate · capability constitution · structural
# query/transform · git work graph · application journeys · capability-aware
# ToolSearch · the built-artifact circuit. Runs every scripts/builtin-tools/
# prove-*.ts via bun run; non-zero exit on any failure. run-all-suites.sh
# auto-joins this suite via its scripts/*/run-all.sh glob.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# builtin-tools — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo
echo ">>> render-builtin-tools-cards.tsx (capability cards, real PTY grid)"
__t=$SECONDS; UI_RENDER=1 "$bun" run "$here"/render-builtin-tools-cards.tsx || fail=1; prover_mark "$here"/render-builtin-tools-cards.tsx "$__t"
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL builtin-tools PROOFS PASS"; else echo "# ❌ SOME builtin-tools PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
