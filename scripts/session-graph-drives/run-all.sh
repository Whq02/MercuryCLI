#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/session-graph/**
# gate-watch: src/commands/crew/* src/crew/crewmates/**
# gate-watch: src/daemon/control/controlServer.ts src/daemon/runner-wire/*
# gate-watch: src/daemon/runner/runHeadless.ts
# gate-watch: scripts/lib/codeText.ts scripts/lib/shippedKeyForms.ts
# gate-watch: src/daemon/session-seat/permissionAsks.ts src/engine/messages/attachmentText.ts
# gate-watch: src/engine/rows/* src/engine/task-framework/tasks.ts
# gate-watch: src/integrations/acp/**
# gate-watch: src/integrations/resources/registry.ts
# gate-watch: src/screen/attention/**
# gate-watch: src/screen/concourse-model/concourseSnapshot.ts src/screen/concourse/ConcourseRoute.tsx
# gate-watch: src/screen/messages/AttachmentMessage.tsx
# gate-watch: src/screen/prompts-panel/PromptsPanel.tsx
# gate-watch: src/screen/prompts-panel/rows.ts
# gate-watch: src/screen/widgets/faces/CrewView.tsx src/screen/workbench/**
# gate-watch: src/sessions/artifacts/**
# gate-watch: src/tools/send-message/SendMessageTool.ts
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
