#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/ui/vshot.py scripts/ui/renderScenarios.ts
# gate-watch: src/components/prompts-panel/**
# gate-watch: src/components/MessageSelector.tsx src/utils/messages/noticeRows.ts
# gate-watch: src/ink.ts src/components/App.tsx src/state/AppStateStore.ts src/keybindings/KeybindingProviderSetup.tsx src/utils/staticRender.tsx
# gate-watch: src/components/messages/UserTextMessage.tsx src/components/MessageRow.tsx src/components/concourse/workerTranscriptFold.ts src/fabric/entryCodec.ts
# gate-watch: src/services/engine-connector/focusedConnector.ts src/services/engine-connector/noSessionConnector.ts src/utils/messages.ts src/utils/config.ts src/types/message.ts
# gate-watch: src/hooks/useSessionConnector.ts
# gate-watch: scripts/lib/captureDriver.ts scripts/lib/fixtureApi.ts scripts/streaming/artifactArena.ts scripts/ui/gridToPng.ts
# gate-watch: src/daemon/concourseWorkers.ts src/daemon/controlSocket.ts src/daemon/warmRunner.ts src/utils/sessionStorage/paths.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/prompts-panel"
fail=0
echo "############################################################"
echo "# PROMPTS PANEL — records · saved prompts"
echo "############################################################"
drive_members prompts-panel 'scripts/prompts-panel/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ PROMPTS PANEL PASS"; else echo "# ❌ PROMPTS PANEL FAILED"; fi
echo "############################################################"
exit "$fail"
