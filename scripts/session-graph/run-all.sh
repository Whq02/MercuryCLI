#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/screen/attention/actions.ts src/screen/attention/contracts.ts src/screen/attention/relations.ts src/screen/attention/statusFeed.ts src/screen/attention/store.ts src/screen/attention/viewModel.ts src/screen/attention/relations.ts
# gate-watch: src/screen/workbench/** src/integrations/acp/**
# gate-watch: src/sessions/artifacts/**
# gate-watch: scripts/streaming/artifactArena.ts
# gate-watch: scripts/ui/render-tui.ts
# gate-watch: src/screen/prompts-panel/PromptsPanel.tsx
# gate-watch: src/screen/prompts-panel/rows.ts
# gate-watch: src/daemon/control/controlServer.ts
# gate-watch: src/integrations/resources/registry.ts
# gate-watch: src/screen/messages/AttachmentMessage.tsx
# gate-watch: src/screen/widgets/faces/CrewView.tsx
# gate-watch: src/tools/send-message/SendMessageTool.ts src/engine/messages/attachmentText.ts
# gate-watch: src/engine/task-framework/tasks.ts
# gate-watch: src/engine/rows/* src/daemon/runner-wire/*
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
