#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/changesets/**
# gate-watch: src/services/changeTransaction/** src/tools/ChangeSetTool/** src/tools/FileReadTool/FileReadTool.ts
# gate-watch: src/components/permissions/ChangeSetPermissionRequest/** src/components/InlineChangeView.tsx
# gate-watch: src/substrate/operationJournal.ts src/substrate/recoveryOrchestrator.ts
# gate-watch: src/tools/LSPTool/mercuryOps.ts src/services/structure/transform.ts src/tools/AstEditTool/AstEditTool.ts
# gate-watch: scripts/lib/captureDriver.ts scripts/ui/renderScenarios.ts scripts/ui/vshot.py src/Tool.ts
# gate-watch: src/services/primitives/transactionPlane.ts src/services/run/effectObserver.ts
# gate-watch: src/services/run/resolveOwner.ts src/services/structure/query.ts src/substrate/durablePublish.ts
# gate-watch: src/substrate/flagRegistry.ts src/tools.ts src/utils/config.ts
# gate-watch: src/utils/fileRead.ts
# gate-watch: src/tools/FileEditTool/FileEditTool.ts src/native-ts/color-diff/index.ts
# gate-watch: src/state/AppStateStore.ts src/tools/FileReadTool/prompt.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/changesets-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'changesets-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members changesets-drives 'scripts/changesets/$name' "$here/members.txt"
