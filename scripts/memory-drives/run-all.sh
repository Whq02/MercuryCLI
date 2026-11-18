#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/memory/**
# gate-watch: src/mneme/** src/tools/JournalTool/** src/constants/tools.ts src/utils/settings/types.ts src/components/Settings/Config.tsx
# gate-watch: docs/MNEME.md docs/MEMORY-FINDINGS.md src/utils/detectSecrets.ts
# gate-watch: src/components/memory/memoryCentreLayout.ts src/commands/memory/memory.tsx src/services/compact/compact.ts
# gate-watch: src/services/eval/evalBridge.ts src/services/instructions/engine.ts src/services/instructions/sourceText.ts
# gate-watch: src/tools.ts src/tools/MemoryTools/MemoryTools.ts
# gate-watch: src/utils/attachments/orchestrator.ts src/constants/prompts.ts src/constants/subagentDoctrine.ts
# gate-watch: src/utils/statusNoticeDefinitions.tsx src/substrate/flagRegistry.ts
# gate-watch: src/utils/capability/declarations.ts src/query/stopHooks.ts
# gate-watch: src/commands.ts src/utils/memory/types.ts src/tools/AgentTool/agentMemory.ts
# gate-watch: src/run-core/turn-machine.ts
# gate-watch: src/components/mercury-ui/useFlatList.ts src/services/engine-connector/focusedConnector.ts src/services/engine-connector/noSessionConnector.ts
# gate-watch: scripts/lib/rows.ts
# gate-watch: scripts/hooks/lib/runDoor.ts src/services/projectIntel/capsule.ts
# gate-watch: src/utils/attachments/contextCapsule.ts scripts/project-intel/fixtures/materialize.ts
# gate-watch: scripts/ui/** scripts/memory-study/**
# gate-watch: scripts/jev/lib/jevStandin.ts src/services/jev/jevClient.ts src/services/jev/jevSetting.ts src/services/jev/jevKey.ts src/services/jev/jevLedger.ts src/tools/MemoryTools/UI.tsx src/tools/MemoryTools/prompt.ts
# gate-watch: src/tools/MemoryTools/ruleCard.ts src/components/permissions/MemoryRulePermissionRequest/MemoryRulePermissionRequest.tsx src/components/permissions/PermissionRequest.tsx
# gate-watch: src/cli/headless/runnerAsks.ts src/utils/permissions/decision/engine.ts src/utils/permissions/decision/wrapper.ts src/utils/permissions/permissions.ts src/utils/permissions/PermissionMode.ts src/cli/run.ts
# gate-watch: src/utils/permissions/decisionReasonWire.ts
# gate-watch: docs/SAMPLES.md src/commands/memory/memoryPage.ts src/services/samples/**
# gate-watch: .gitignore scripts/vendor/build-embed.ts scripts/vendor/fetch-embed-models.ts native/embed/**
# gate-watch: src/tools/RecordConventionTool/RecordConventionTool.ts src/tools/RecordConventionTool/prompt.ts scripts/lib/hermetic.ts
# gate-watch: scripts/lib/flagRegistrySource.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/memory-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'memory-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members memory-drives 'scripts/memory/$name' "$here/members.txt"
