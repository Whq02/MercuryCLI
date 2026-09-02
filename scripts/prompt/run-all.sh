#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/prompt/composer* src/services/analytics/** src/tools/AgentTool/builtInAgents*
# gate-watch: src/utils/effort*
# gate-watch: src/utils/profile/appearanceSnapshot* src/utils/profile/mercuryProfile*
# gate-watch: src/utils/cockpit/promptProvenance*
# prompt-composer floors — proof harness (src/prompt/composer.ts). Runs every
# scripts/prompt/prove-*.ts via bun run; non-zero exit on any failure. New
# proofs are picked up by the glob. Files prefixed '_' (e.g. the concurrency
# worker) are helpers, not proofs, and are excluded.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# prompt-composer floors — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL PROMPT PROOFS PASS"; else echo "# ❌ SOME PROMPT PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
