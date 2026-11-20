#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/attention/** src/services/attention/relations.ts
# gate-watch: src/services/workbench/** src/services/acp/**
# gate-watch: src/utils/artifacts/**
# gate-watch: scripts/streaming/artifactArena.ts
# gate-watch: scripts/ui/render-tui.ts
# gate-watch: src/components/prompts-panel/PromptsPanel.tsx
# gate-watch: src/components/prompts-panel/rows.ts
# gate-watch: src/daemon/controlServer.ts
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
