#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/session-graph/**
# gate-watch: src/services/attention/** src/services/attention/relations.ts
# gate-watch: src/services/workbench/** src/services/acp/** src/input-core/composer-document.ts
# gate-watch: src/utils/artifacts/**
# gate-watch: scripts/lib/codeText.ts scripts/lib/shippedKeyForms.ts
# gate-watch: src/cli/run.ts src/commands/crew/index.ts
# gate-watch: src/components/concourse/ConcourseRoute.tsx src/components/prompts-panel/PromptsPanel.tsx
# gate-watch: src/components/prompts-panel/rows.ts
# gate-watch: src/keybindings/defaultBindings.ts src/services/concourse/concourseSnapshot.ts
# gate-watch: src/services/crew/**
# gate-watch: src/daemon/permissionAsks.ts src/daemon/controlServer.ts
# gate-watch: src/services/resources/registry.ts
# gate-watch: src/components/messages/AttachmentMessage.tsx
# gate-watch: src/components/mercury-ui/screens/CrewView.tsx
# gate-watch: src/tools/SendMessageTool/SendMessageTool.ts src/utils/messages/attachmentText.ts
# gate-watch: src/utils/tasks.ts
# gate-watch: src/rows/* src/runner/wire/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/session-graph-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'session-graph-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members session-graph-drives 'scripts/session-graph/$name' "$here/members.txt"
