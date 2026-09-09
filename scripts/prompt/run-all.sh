#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/prompt/composer* src/services/analytics/** src/tools/AgentTool/builtInAgents*
# gate-watch: src/utils/effort*
# gate-watch: src/utils/profile/appearanceSnapshot* src/utils/profile/mercuryProfile*
# gate-watch: src/utils/cockpit/promptProvenance* src/utils/cockpit/runProtocol*
# gate-watch: src/constants/prompts.ts src/constants/systemPromptSections.ts src/tools/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

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
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL PROMPT PROOFS PASS"; else echo "# ❌ SOME PROMPT PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
