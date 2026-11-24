#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/memory/**
# gate-watch: src/commands/catalogue/commands.ts src/crew/agents/agentMemory.ts
# gate-watch: docs/MNEME.md docs/MEMORY-FINDINGS.md
# gate-watch: src/daemon/runner/runHeadless.ts
# gate-watch: src/engine/compaction/foldConversation.ts src/engine/turn-entry/stopHooks.ts
# gate-watch: src/integrations/samples/** src/models/jev/jevClient.ts
# gate-watch: src/permissions/capability/declarations.ts src/permissions/rules/decision/engine.ts src/permissions/rules/permissionDoor.ts
# gate-watch: src/permissions/rules/permissionMode.ts
# gate-watch: scripts/lib/rows.ts
# gate-watch: scripts/hooks/lib/runDoor.ts
# gate-watch: scripts/project-intel/fixtures/materialize.ts
# gate-watch: scripts/ui/** scripts/memory-study/**
# gate-watch: scripts/jev/lib/jevStandin.ts src/screen/widgets/useFlatList.ts
# gate-watch: src/sessions/instructions/sourceText.ts src/sessions/instruction-contracts/instructionFileType.ts src/sessions/mneme/** src/tools/engines/eval-kernels/evalBridge.ts
# gate-watch: docs/SAMPLES.md src/tools/journal/**
# gate-watch: .gitignore scripts/vendor/build-embed.ts scripts/vendor/fetch-embed-models.ts native/embed/**
# gate-watch: scripts/lib/hermetic.ts
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
