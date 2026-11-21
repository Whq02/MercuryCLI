#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/memory/**
# gate-watch: src/mneme/** src/tools/JournalTool/**
# gate-watch: docs/MNEME.md docs/MEMORY-FINDINGS.md
# gate-watch: src/services/compact/compact.ts
# gate-watch: src/services/eval/evalBridge.ts src/services/instructions/sourceText.ts
# gate-watch: src/utils/capability/declarations.ts src/query/stopHooks.ts
# gate-watch: src/commands.ts src/utils/memory/types.ts src/utils/agentMemory.ts
# gate-watch: src/components/mercury-ui/useFlatList.ts
# gate-watch: scripts/lib/rows.ts
# gate-watch: scripts/hooks/lib/runDoor.ts
# gate-watch: scripts/project-intel/fixtures/materialize.ts
# gate-watch: scripts/ui/** scripts/memory-study/**
# gate-watch: scripts/jev/lib/jevStandin.ts src/services/jev/jevClient.ts
# gate-watch: src/utils/permissions/decision/engine.ts src/utils/permissions/permissions.ts src/utils/permissions/PermissionMode.ts src/cli/run.ts
# gate-watch: docs/SAMPLES.md src/services/samples/**
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
