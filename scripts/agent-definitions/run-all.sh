#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/agents/* src/tools/AgentTool/loadAgentsDir* src/components/agents/* src/utils/markdownConfigLoader* src/cli/agentFreshness*
# the Agent Studio convergence proof harness. Codec, exact
# identity, discovery precedence, transactional store, resolver truth, watch,
# drafts, scale. Every scripts/agent-definitions/prove-*.ts runs via bun; non-zero exit
# on any failure; new proofs join by glob.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
# SUITE-LEVEL ISOLATION: proofs never read the operator's machine — each one
# builds its own scratch HOME/config roots (the F6 ambient-state law) and the
# evolution ledger stays off.
export MERCURY_EVOLUTION_LEDGER=0
# Source-run provers have no dist-sibling vendored ripgrep — the loader falls
# back to its native markdown walker, so discovery is hermetic.
echo "############################################################"
echo "# agent-definitions — Agent Studio proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL agent-definitions PROOFS PASS"; else echo "# ❌ SOME agent-definitions PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
