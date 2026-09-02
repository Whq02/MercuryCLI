#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/prompt/composer* src/services/analytics/** src/tools/AgentTool/builtInAgents*
# gate-watch: src/utils/effort*
# gate-watch: src/utils/profile/appearanceSnapshot* src/utils/profile/mercuryProfile*
# gate-watch: src/utils/cockpit/promptProvenance*
set -u
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
