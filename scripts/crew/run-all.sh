#!/usr/bin/env bash
# gate-watch: src/services/providers/local/ollamaChatTransport.ts src/services/providers/openaicompat/compatChatCallModel.ts
# gate-watch: src/substrate/operationJournal.ts
# gate-class: cpu
# gate-watch: src/services/agentResults/summaryRoom.ts src/types/textInputTypes.ts src/types/messageQueueTypes.ts
# gate-watch: src/tools/SendMessageTool/** src/tools/ResumeAgentTool/** src/commands/swarm/** src/components/prompts-panel/** src/utils/settings/** scripts/ui/gridToPng.ts scripts/ui/renderScenarios.ts
# gate-watch: src/services/providers/toolEconomy.ts src/services/providers/anthropic/boundPrefixRecord.ts
# gate-watch: src/daemon/**
# gate-watch: src/utils/daemonBreaker*
# gate-watch: src/run-core/project-legacy.ts
# gate-watch: src/commands/swarmchat/** src/utils/sessionStorage/rowGraph.ts src/utils/conversationRecovery.ts
# gate-watch: src/state/crewLedger.ts
# gate-watch: src/services/concourse/workerModels.ts
# gate-watch: src/services/engine-connector/*
# gate-watch: src/state/crewLedger.ts
# gate-watch: src/tools/AgentTool/*
# gate-watch: src/utils/*
# gate-watch: src/utils/accounts/signInLedger.ts
# gate-watch: src/utils/messages/* src/utils/model/computedDefault.ts
# gate-watch: src/utils/model/configs.ts
# gate-watch: src/utils/task/*
# gate-watch: src/components/PromptInput/PromptInput.tsx
# gate-watch: src/components/tasks/useCrewmateTranscript.ts
# gate-watch: package.json scripts/builtin-tools/fixtures/tool-census.json scripts/builtin-tools/fixtures/tool-census.md scripts/project-services/fixtures/inventory.json
# gate-watch: src/utils/capability/declarations.ts src/utils/crew/agentLaunchPlan.ts
# gate-watch: src/utils/hooks/hookEvents.ts src/utils/hooks/fire.ts src/services/oauth/client.ts
# gate-watch: src/utils/tasks.ts src/utils/agentContext.ts
# gate-watch: src/commands/tasks/index.ts src/components/tasks/BackgroundTasksDialog.tsx src/services/crew/identity.ts
# gate-watch: src/utils/crew/crewStart.ts
# gate-watch: src/utils/crew/crewAccountChange.ts
# gate-watch: docs/CREW.md docs/ENGINES.md README.md src/setup.ts src/components/Settings/Config.tsx
# gate-watch: src/rows/*
# gate-watch: src/constants/agentMessage.ts
# gate-watch: src/run-core/turn/**
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
export MERCURY_EVOLUTION_LEDGER=0
scratch_home="$(mktemp -d "${TMPDIR:-/tmp}/crew-proof-home.XXXXXX")"
export MERCURY_CONFIG_DIR="$scratch_home"
unset MERCURY_DAEMON_PERMISSION_MODE MERCURY_WORKER_RECON_ALLOW 2>/dev/null || true
trap 'rm -rf "$scratch_home"; suite_home_cleanup' EXIT
echo "############################################################"
echo "# Crewmates — proof harness"
echo "############################################################"
shopt -s nullglob
claimed=$(members_cat scripts/crew-*/members.txt)
globs=("$here"/prove-*.ts)
for proof in "${globs[@]}"; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")"; then continue; fi
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL CREW PROOFS PASS"; else echo "# ❌ SOME CREW PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
