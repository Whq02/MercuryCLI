#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/daemon/control/controlServer.ts src/daemon/runner-wire/*
# gate-watch: src/engine/messages/attachmentText.ts src/engine/rows/*
# gate-watch: src/engine/task-framework/tasks.ts
# gate-watch: scripts/streaming/artifactArena.ts
# gate-watch: scripts/ui/render-tui.ts
# gate-watch: src/integrations/acp/**
# gate-watch: src/integrations/resources/registry.ts
# gate-watch: src/screen/attention/**
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
here="scripts/session-graph"
fail=0

echo "############################################################"
echo "# session-graph — the living-crew lane"
echo "############################################################"

drive_members session-graph 'scripts/session-graph/$name' "$here/members.txt" || fail=1

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ session-graph PASS"; else echo "# ❌ session-graph FAILED"; fi
echo "############################################################"
exit "$fail"
