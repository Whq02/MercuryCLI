#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/pings/**
# gate-watch: src/hooks/useTurnEndPing.ts src/ink/termio/notifyPing.ts src/ink/session/focus-store.ts
# gate-watch: src/ink/terminalWrite.ts src/utils/settings/types.ts src/services/attention/**
# gate-watch: src/bootstrap/state.ts src/utils/settings/settingsCache.ts scripts/settings/settings-schema.json
# gate-watch: src/components/permissions/PermissionRequest.tsx src/components/mcp/ElicitationDialog.tsx
# gate-watch: src/components/MercuryFrame.tsx src/services/engine-connector/daemonConnector.ts src/daemon/concourseWorkers.ts
# gate-watch: src/components/messages/SystemTextMessage.tsx
# gate-watch: scripts/lib/captureDriver.ts scripts/lib/firstRunSeed.ts scripts/lib/fixtureApi.ts scripts/ui/vshot.py
# gate-watch: scripts/streaming/artifactArena.ts src/commands.ts
# gate-watch: src/commands/model/mercuryModel.tsx src/commands/model/model.tsx
# gate-watch: src/components/HelpV2/commandDomains.ts src/components/PromptInput/PromptInput.tsx
# gate-watch: src/components/Settings/Config.tsx src/components/concourse/ConcourseStrips.tsx
# gate-watch: src/components/mercury-ui/needsYouJump.ts src/constants/figures.ts src/daemon/sessionSeat.ts
# gate-watch: src/fabric/entryCodec.ts src/fabric/ordinal.ts src/hooks/useGlobalKeybindings.tsx
# gate-watch: src/keybindings/actionGraph.ts src/keybindings/defaultBindings.ts src/screens/Chat.tsx
# gate-watch: src/services/crew/obligations.ts src/services/crew/obligationsBridge.ts
# gate-watch: src/services/engine-connector/seatProjections.ts src/utils/*
# gate-watch: src/services/engine-connector/focusedConnector.ts src/services/engine-connector/seatLive.ts
# gate-watch: src/ink.ts src/utils/config/globalConfig.ts scripts/lib/seedTranscript.ts
# gate-watch: src/components/PromptInput/useComposerModelDoors.tsx
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/pings-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'pings-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members pings-drives 'scripts/pings/$name' "$here/members.txt" 3
