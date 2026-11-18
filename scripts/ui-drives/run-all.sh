#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/services/switchboard/hopIntoSession.ts
# gate-watch: src/components/messages/TurnReceiptRow.tsx src/components/KitMenuScreen.tsx src/services/kitMenu/** src/utils/cockpit/turnReceipt.ts src/ink/** src/services/engine-connector/daemonConnector.ts src/services/engine-connector/queuedNotices.ts src/components/Messages.tsx src/components/LiveStreamingTail.tsx src/screens/Chat.tsx
# gate-watch: src/components/StructuredDiff.tsx src/components/StructuredDiff/** src/components/StructuredDiffList.tsx src/components/FileEditToolUpdatedMessage.tsx src/native-ts/color-diff/** src/tools/FileWriteTool/UI.tsx
# gate-watch: scripts/crew/crew-world.ts
# gate-watch: scripts/lib/*
# gate-watch: scripts/ui/*
# gate-watch: src/components/Settings/Jev.tsx src/components/Settings/Settings.tsx src/components/SettingsPopupSlot.tsx src/components/MercuryFilesMenu.tsx src/utils/cockpit/settingsPopup.ts src/utils/cockpit/filesMenu.ts src/utils/cockpit/popupOwnsKeys.ts src/components/PromptInput/PromptInput.tsx
# gate-watch: src/components/tasks/BackgroundTasksDialog.tsx src/components/CrewmateTranscript.tsx src/components/tasks/useCrewmateTranscript.ts src/components/CompactIdentityBand.tsx src/components/CrewmateCard.tsx src/utils/cockpit/crewmateWords.ts src/components/mercury-ui/screens/CrewView.tsx src/utils/cockpit/zenMode.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/ui-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'ui-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members ui-drives 'scripts/ui/$name' "$here/members.txt"
