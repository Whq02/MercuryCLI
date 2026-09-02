#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/router/** src/utils/swarm/agentLaunchPlan* src/utils/swarm/roleResolver*
# gate-watch: src/services/providers/**
# gate-watch: src/query/deps* src/utils/swarm/engineDispatch* src/tools/AgentTool/AgentTool*
# native specialist engines (Codex App Server + Z.AI GLM).
# Runs every scripts/agent-dispatch/prove-*.ts via bun run; non-zero exit on any
# failure. New proofs are picked up by the glob; the pooled green gate
# (scripts/run-all-suites.sh) picks THIS suite up by ITS glob.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
# SUITE-LEVEL ISOLATION (the party-suite lesson): proofs run with the
# evolution ledger OFF and against scratch state roots, so a gate run never
# seeds live operator stores with fixture rows. Provider proofs are
# deterministic fixtures ONLY — no network, no billable calls, ever.
export MERCURY_EVOLUTION_LEDGER=0
scratch_state="$(mktemp -d "${TMPDIR:-/tmp}/orbit-proof-state.XXXXXX")"
export MERCURY_ROUTER_STATE_DIR="$scratch_state"
trap 'rm -rf "$scratch_state"' EXIT
echo "############################################################"
echo "# agent-dispatch — specialist-engine proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo
if [ "$fail" -eq 0 ]; then
  echo "AGENT-DISPATCH SUITE GREEN"
else
  echo "AGENT-DISPATCH SUITE RED"
fi
exit "$fail"
