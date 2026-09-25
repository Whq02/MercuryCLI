#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/notifications/**
# gate-watch: scripts/notifications/**
# gate-watch: src/services/crew/** src/services/notifier.ts
# gate-watch: scripts/engine-durability/harness.ts scripts/lib/firstRunSeed.ts scripts/lib/fixtureApi.ts
# gate-watch: scripts/staleness/prove-stale-registry.ts src/boot/launchGraph.ts src/bootstrap/state.ts
# gate-watch: src/components/concourse/* src/components/mercury-ui/CritterArt.tsx
# gate-watch: src/components/mercury-ui/keyHintLabel.ts src/context/surfaceRoute.ts src/daemon/*
# gate-watch: src/hooks/useConcourseLifecycleSignals.ts src/hooks/useObligationSignals.ts
# gate-watch: src/ink/components/App.tsx src/ink/events/input-event.ts src/ink/ink.tsx
# gate-watch: src/ink/root/terminalModeLedger.ts src/main.tsx src/query.ts src/run-core/turn-machine.ts
# gate-watch: src/screens/ResumeConversation.tsx src/services/api/recoveryBudget.ts
# gate-watch: src/services/api/sdkErrors.ts src/services/attention/store.ts src/services/capacity/*
# gate-watch: src/services/channel/frame.ts src/services/concourse/**
# gate-watch: src/services/engine-connector/crewFacts.ts src/services/mcp/renderTuiTool.ts
# gate-watch: src/services/notificationPolicy.ts src/services/providers/openai/*
# gate-watch: src/services/providers/providerUsage.ts src/services/switchboard/capacityCheck.ts
# gate-watch: src/state/AppStateStore.ts src/substrate/* src/tasks/LocalAgentTask/agentWait.ts
# gate-watch: src/tools/WorkflowTool/* src/utils/* src/utils/cockpit/critterData.ts
# gate-watch: src/utils/config/globalConfig.ts src/utils/router/modelRegistry.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# notifications — the Session Concourse lane"
echo "############################################################"

claimed=$(cat scripts/notifications-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')

for proof in "$here"/prove-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")"; then continue; fi
  [ -e "$proof" ] || continue
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; (cd "$repo" && "$bun" run "$proof") || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done

for repro in "$here"/repro-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$repro")"; then continue; fi
  [ -e "$repro" ] || continue
  echo
  echo "── $(basename "$repro") ──"
  __t=$SECONDS; __rc=0; (cd "$repo" && "$bun" run "$repro") || { __rc=$?; fail=1; }; prover_mark "$repro" "$__t" "$__rc"
done

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ notifications PASS"; else echo "# ❌ notifications FAILED"; fi
echo "############################################################"
exit "$fail"
