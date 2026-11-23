#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/motion/**
# gate-watch: src/screen/renderer/bindings/** src/screen/renderer/elements/MotionParkContext.ts src/screen/composer/Composer.tsx src/screen/composer/ComposerFooter.tsx src/screen/composer/ComposerFooterLeftSide.tsx src/screen/composer/ComposerFooterSuggestions.tsx src/screen/composer/ComposerHelpMenu.tsx src/screen/composer/ComposerModeIndicator.tsx src/screen/composer/ComposerStashNotice.tsx src/screen/composer/ExitChordNotice.tsx src/screen/composer/HistorySearchInput.tsx src/screen/composer/IssueFlagBanner.tsx src/screen/composer/Notifications.tsx src/screen/composer/ShimmeredInput.tsx src/screen/composer/composerConfig.ts src/screen/composer/composerEffortNotice.ts src/screen/composer/composerFrame.tsx src/screen/composer/composerInsert.ts src/screen/composer/composerModelDoorsParts.tsx src/screen/composer/composerOverlay.ts src/screen/composer/composerRouteInput.ts src/screen/composer/composerSurface.tsx src/screen/composer/composerText.ts src/screen/composer/composerView.tsx src/screen/composer/crewmateCommands.tsx src/screen/composer/footerLeftSideView.tsx src/screen/composer/inputModes.ts src/screen/composer/inputTruncation.ts src/screen/composer/promptIntent.ts src/screen/composer/suggestionSelectionStore.ts src/screen/composer/useComposerAttachments.ts src/screen/composer/useComposerCompactFocus.ts src/screen/composer/useComposerCrewmateRefs.ts src/screen/composer/useComposerDraft.ts src/screen/composer/useComposerEffortNotice.ts src/screen/composer/useComposerHelm.ts src/screen/composer/useComposerHighlights.ts src/screen/composer/useComposerHistory.ts src/screen/composer/useComposerKeybindings.ts src/screen/composer/useComposerModelDoors.tsx src/screen/composer/useComposerPlaceholder.ts src/screen/composer/useComposerRawKeys.ts src/screen/composer/useComposerSelection.ts src/screen/composer/useComposerState.ts src/screen/composer/useComposerSubmit.ts src/screen/composer/useComposerSuggestions.ts src/screen/composer/useComposerVoice.ts src/screen/composer/useComposerWiring.ts src/screen/composer/useCrewBanner.ts src/screen/composer/useInputTruncation.ts assets/splash/**
# gate-watch: src/screen/renderer/screenInstance.tsx src/boot/setupScreens.tsx src/boot/main.tsx src/screen/frame-chips/MercuryFrame.tsx
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/motion-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'motion-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members motion-drives 'scripts/motion/$name' "$here/members.txt"
