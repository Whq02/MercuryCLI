#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/providers/** src/utils/router/** src/utils/model/**
# gate-watch: src/utils/modelCost.ts src/utils/context.ts src/utils/sessionRestore.ts
# gate-watch: src/utils/swarm/engineDispatch* src/utils/swarm/agentLaunchPlan*
# gate-watch: src/types/message.ts
# gate-watch: src/prompt/** src/utils/messages/pairing.ts
# GPT-5.6+ primary agency on the native OpenAI Responses
# transport. Runs every scripts/model-routing/prove-*.ts via bun run; non-zero exit on
# any failure. New proofs are picked up by the glob; the pooled green gate
# (scripts/run-all-suites.sh) picks THIS suite up by ITS glob.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
# SUITE-LEVEL ISOLATION (the party-suite lesson): proofs run with the
# evolution ledger OFF; every prover pins its own scratch config home. All
# provider proofs are deterministic fixtures — no network, no billables, ever
# (the fixture bases pin to an unroutable loopback port).
export MERCURY_EVOLUTION_LEDGER=0
echo "############################################################"
echo "# model-routing — native GPT primary-agency proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo
if [ "$fail" -eq 0 ]; then
  echo "MODEL-ROUTING SUITE GREEN"
else
  echo "MODEL-ROUTING SUITE RED"
fi
exit "$fail"
