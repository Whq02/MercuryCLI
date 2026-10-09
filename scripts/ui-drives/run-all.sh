#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/components/messages/TurnReceiptRow.tsx src/components/KitMenuScreen.tsx src/services/kitMenu/** src/utils/cockpit/turnReceipt.ts src/ink/** src/services/engine-connector/daemonConnector.ts src/services/engine-connector/queuedNotices.ts src/components/Messages.tsx src/components/LiveStreamingTail.tsx src/screens/Chat.tsx
# gate-watch: src/components/StructuredDiff.tsx src/components/StructuredDiff/** src/components/StructuredDiffList.tsx src/components/FileEditToolUpdatedMessage.tsx src/native-ts/color-diff/** src/tools/FileWriteTool/UI.tsx
# gate-watch: scripts/computer/computerDriveKit.ts scripts/crew/crew-stop-fixture.ts scripts/crew/crew-look-fixture.ts scripts/crew/crew-world.ts
# gate-watch: scripts/daemon/dupline-world.ts scripts/journey/cap-offer-fixture-server.ts scripts/lib/*
# gate-watch: scripts/stop-policy/prove-no-stagnation-governor.ts scripts/ui/* src/commands/login/login.tsx
# gate-watch: src/components/MercurySetupFrame.tsx src/components/Onboarding.tsx
# gate-watch: src/components/mercury-ui/keyHintLabel.ts src/daemon/controlSocket.ts
# gate-watch: src/services/providers/deepseek/deepseekPins.ts src/utils/accounts/signInLedger.ts
# gate-watch: src/utils/config/globalConfig.ts src/utils/sessionStoragePortable.ts
# gate-watch: src/components/Settings/Jev.tsx src/components/Settings/Settings.tsx src/components/SettingsPopupSlot.tsx src/components/MercuryFilesMenu.tsx src/utils/cockpit/settingsPopup.ts src/utils/cockpit/filesMenu.ts src/utils/cockpit/popupOwnsKeys.ts src/components/PromptInput/PromptInput.tsx
# gate-watch: src/services/jev/jevSetting.ts
# gate-watch: src/utils/model/modelPickerFooter.ts src/utils/model/modelPickerGroups.ts
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
