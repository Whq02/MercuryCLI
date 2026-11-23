#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/screen/renderer/input/**
# gate-watch: src/screen/composer/Composer.tsx src/screen/composer/ComposerFooter.tsx src/screen/composer/ComposerFooterLeftSide.tsx src/screen/composer/ComposerFooterSuggestions.tsx src/screen/composer/ComposerHelpMenu.tsx src/screen/composer/ComposerModeIndicator.tsx src/screen/composer/ComposerStashNotice.tsx src/screen/composer/ExitChordNotice.tsx src/screen/composer/HistorySearchInput.tsx src/screen/composer/IssueFlagBanner.tsx src/screen/composer/Notifications.tsx src/screen/composer/ShimmeredInput.tsx src/screen/composer/composerConfig.ts src/screen/composer/composerEffortNotice.ts src/screen/composer/composerFrame.tsx src/screen/composer/composerInsert.ts src/screen/composer/composerModelDoorsParts.tsx src/screen/composer/composerOverlay.ts src/screen/composer/composerRouteInput.ts src/screen/composer/composerSurface.tsx src/screen/composer/composerText.ts src/screen/composer/composerView.tsx src/screen/composer/crewmateCommands.tsx src/screen/composer/footerLeftSideView.tsx src/screen/composer/inputModes.ts src/screen/composer/inputTruncation.ts src/screen/composer/promptIntent.ts src/screen/composer/suggestionSelectionStore.ts src/screen/composer/useComposerAttachments.ts src/screen/composer/useComposerCompactFocus.ts src/screen/composer/useComposerCrewmateRefs.ts src/screen/composer/useComposerDraft.ts src/screen/composer/useComposerEffortNotice.ts src/screen/composer/useComposerHelm.ts src/screen/composer/useComposerHighlights.ts src/screen/composer/useComposerHistory.ts src/screen/composer/useComposerKeybindings.ts src/screen/composer/useComposerModelDoors.tsx src/screen/composer/useComposerPlaceholder.ts src/screen/composer/useComposerRawKeys.ts src/screen/composer/useComposerSelection.ts src/screen/composer/useComposerState.ts src/screen/composer/useComposerSubmit.ts src/screen/composer/useComposerSuggestions.ts src/screen/composer/useComposerVoice.ts src/screen/composer/useComposerWiring.ts src/screen/composer/useCrewBanner.ts src/screen/composer/useInputTruncation.ts
# gate-watch: src/screen/composer/input-core/backslashContinuation.ts src/screen/composer/input-core/command-queue.ts src/screen/composer/input-core/composer-document.ts src/screen/composer/input-core/interruptArity.ts src/screen/composer/input-core/pending-input.ts src/screen/composer/input-core/sendNowChord.ts
# gate-watch: src/tools/structure/**
# gate-watch: src/tools/engines/structure/** src/tools/lsp/**
# gate-watch: src/commands/model/mercuryModel.tsx
# gate-watch: src/commands/model/picker/MercuryModelPicker.tsx
# gate-watch: src/screen/fullscreen-layout/HelmLanesRail.tsx
# gate-watch: scripts/lib/* scripts/ui/renderScenarios.ts scripts/ui/vshot.py
# gate-watch: src/platform/environment/platform.ts
# gate-watch: src/screen/composer/usePasteHandler.ts src/screen/composer/text-input/BaseTextInput.tsx scripts/streaming/ptydrive.py
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/prompt-input"
overall=0
drive_members prompt-input 'scripts/prompt-input/$name' "$here/members.txt" '' run || overall=1
exit $overall
