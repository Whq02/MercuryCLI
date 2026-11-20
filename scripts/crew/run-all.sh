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
# gate-watch: src/commands/swarmchat/** src/services/resume/conversationRecovery.ts
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
# gate-watch: package.json scripts/project-services/fixtures/inventory.json
# gate-watch: src/utils/capability/declarations.ts src/services/crew/agentLaunchPlan.ts
# gate-watch: src/utils/hooks/hookEvents.ts src/utils/hooks/fire.ts src/services/oauth/client.ts
# gate-watch: src/utils/tasks.ts src/utils/agentContext.ts
# gate-watch: src/commands/tasks/index.ts src/components/tasks/BackgroundTasksDialog.tsx src/services/crew/identity.ts
# gate-watch: src/utils/crew/crewStart.ts
# gate-watch: src/services/crew/crewAccountChange.ts
# gate-watch: docs/CREW.md docs/ENGINES.md README.md src/setup.ts src/components/Settings/Config.tsx
# gate-watch: src/rows/*
# gate-watch: src/constants/agentMessage.ts
# gate-watch: src/run-core/turn/**
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/crew"
fail=0
export MERCURY_EVOLUTION_LEDGER=0
scratch_home="$(mktemp -d "${TMPDIR:-/tmp}/crew-proof-home.XXXXXX")"
export MERCURY_CONFIG_DIR="$scratch_home"
unset MERCURY_DAEMON_PERMISSION_MODE MERCURY_WORKER_RECON_ALLOW 2>/dev/null || true
trap 'rm -rf "$scratch_home"; suite_home_cleanup' EXIT
echo "############################################################"
echo "# Crewmates — proof harness"
echo "############################################################"
drive_members crew 'scripts/crew/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL CREW PROOFS PASS"; else echo "# ❌ SOME CREW PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
