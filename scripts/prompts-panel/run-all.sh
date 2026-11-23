#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/ui/vshot.py scripts/ui/renderScenarios.ts
# gate-watch: src/screen/prompts-panel/**
# gate-watch: src/screen/rewind-picker/RewindPicker.tsx src/engine/message-shapes/noticeRows.ts
# gate-watch: src/screen/themedRenderer.ts src/boot/App.tsx src/screen/app-state/AppStateStore.ts src/screen/keys/KeybindingProviderSetup.tsx src/screen/renderer/staticRender.tsx
# gate-watch: src/screen/messages/UserTextMessage.tsx src/screen/messages/MessageRow.tsx src/screen/concourse/workerTranscriptFold.ts
# gate-watch: src/engine/connector/focusedConnector.ts src/engine/connector/noSessionConnector.ts src/engine/messages/messages.ts src/platform/settings/config.ts src/engine/message-shapes/message.ts
# gate-watch: src/screen/focused-session/useSessionConnector.ts
# gate-watch: scripts/lib/captureDriver.ts scripts/lib/fixtureApi.ts scripts/streaming/artifactArena.ts scripts/ui/gridToPng.ts
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
