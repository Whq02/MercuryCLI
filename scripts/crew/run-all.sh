#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/ui/vshot.py src/daemon/** src/utils/crew/crewClient*
# gate-watch: src/utils/daemonBreaker* src/utils/swarm/teamHelpers*
# gate-watch: src/utils/teammateMailbox*
# gate-watch: src/tasks/LocalAgentTask/launchReceipts* src/tools/AgentTool/resumeAgent*
# gate-watch: src/tools/SendMessageTool/**
# gate-watch: docs/SESSIONS.md scripts/daemon/dupline-world.ts scripts/lib/firstRunSeed.ts
# gate-watch: scripts/lib/fixtureApi.ts src/Task.ts src/bootstrap/state.ts src/cli/print.ts
# gate-watch: src/commands/exit/exit.tsx src/components/MercuryExitConfirm.tsx
# gate-watch: src/components/PromptInput/Notifications.tsx src/components/mercury-ui/screens/CrewView.tsx
# gate-watch: src/components/mercury-ui/screens/crewPauseDoor.ts src/run-core/pauseGate.ts
# gate-watch: src/query.ts src/entrypoints/sdk/controlSchemas.ts src/entrypoints/sdk/controlTypes.ts
# gate-watch: src/tools/WorkflowTool/runControl.ts src/tools/WorkflowTool/WorkflowTool.tsx
# gate-watch: src/components/messages/UserAgentNotificationMessage.tsx src/fabric/entryCodec.ts
# gate-watch: src/fabric/ordinal.ts src/hooks/useCancelRequest.ts src/input-core/command-queue.ts
# gate-watch: src/services/agentResults/normalize.ts src/services/agents/operatorResume.ts
# gate-watch: src/services/agents/operatorStop.ts src/services/api/errors.ts src/services/compact/compact.ts
# gate-watch: src/services/compact/prompt.ts src/services/concourse/workerModels.ts
# gate-watch: src/services/crew/adapters/ndjsonChild.ts src/services/crew/dispatch.ts
# gate-watch: src/services/engine-connector/* src/services/notices/idleNudge.ts
# gate-watch: src/services/notices/unreadLedger.ts src/services/resources/adapters/agent.ts
# gate-watch: src/services/resources/adapters/transcript.ts src/services/resources/contracts.ts
# gate-watch: src/state/AppStateStore.ts src/substrate/flagRegistry.ts src/substrate/storeRecovery.ts
# gate-watch: src/tasks.ts src/tasks/LocalAgentTask/* src/tasks/LocalMainSessionTask.ts
# gate-watch: src/tasks/LocalWorkflowTask/LocalWorkflowTask.tsx src/tasks/stopTask.ts src/tools/AgentTool/*
# gate-watch: src/tools/AgentTool/built-in/generalPurposeAgent.ts src/tools/TaskOutputTool/TaskOutputTool.tsx
# gate-watch: src/tools/shared/spawnMultiAgent.ts src/types/ids.ts src/utils/*
# gate-watch: src/utils/accounts/signInLedger.ts src/utils/attachments/orchestrator.ts
# gate-watch: src/utils/config/globalConfig.ts src/utils/messages/* src/utils/model/computedDefault.ts
# gate-watch: src/utils/model/configs.ts src/utils/sessionStorage/logs.ts src/utils/sessionStorage/paths.ts
# gate-watch: src/utils/swarm/busEnvelopes.ts src/utils/swarm/spawnInProcess.ts src/utils/task/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
export MERCURY_EVOLUTION_LEDGER=0
scratch_home="$(mktemp -d "${TMPDIR:-/tmp}/crew-proof-home.XXXXXX")"
export MERCURY_CONFIG_DIR="$scratch_home"
unset MERCURY_CREW MERCURY_CREW_AGENT MERCURY_DAEMON_CREW MERCURY_DAEMON_PERMISSION_MODE MERCURY_WORKER_RECON_ALLOW 2>/dev/null || true
trap 'rm -rf "$scratch_home"; suite_home_cleanup' EXIT
echo "############################################################"
echo "# Crew teammates — proof harness"
echo "############################################################"
shopt -s nullglob
globs=("$here"/prove-*.ts)
[ "${UI_RENDER:-0}" = "1" ] && globs+=("$here"/render-*.ts)
for proof in "${globs[@]}"; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL CREW PROOFS PASS"; else echo "# ❌ SOME CREW PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
