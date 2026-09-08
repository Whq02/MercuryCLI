#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/providers/** src/utils/router/** src/utils/model/**
# gate-watch: src/utils/modelCost.ts src/utils/context.ts src/utils/sessionRestore.ts
# gate-watch: src/utils/swarm/engineDispatch* src/utils/swarm/agentLaunchPlan*
# gate-watch: src/types/message.ts
# gate-watch: src/prompt/** src/utils/messages/pairing.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
export MERCURY_EVOLUTION_LEDGER=0
echo "############################################################"
echo "# model-routing — native GPT primary-agency proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo
if [ "$fail" -eq 0 ]; then
  echo "MODEL-ROUTING SUITE GREEN"
else
  echo "MODEL-ROUTING SUITE RED"
fi
exit "$fail"
