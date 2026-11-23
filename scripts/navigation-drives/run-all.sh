#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/screen/widgets/AnimatedCritterArt.tsx src/screen/widgets/CritterArt.tsx src/screen/widgets/CursorRow.tsx src/screen/widgets/EffortChip.tsx src/screen/widgets/EffortStrip.tsx src/screen/widgets/FailoverMark.tsx src/screen/widgets/InteractiveDisclosure.tsx src/screen/widgets/InteractiveRow.tsx src/screen/widgets/LiveGlyphs.tsx src/screen/widgets/MiniCritter.tsx src/screen/widgets/NavigablePanes.tsx src/screen/widgets/PaletteView.tsx src/screen/widgets/RailPanel.tsx src/screen/widgets/SceneCanvas.tsx src/screen/widgets/TrimChip.tsx src/screen/widgets/WorkCapsule.tsx src/screen/widgets/appearanceSnapshot.ts src/screen/widgets/assets.tsx src/screen/widgets/compactModeChip.ts src/screen/widgets/components.tsx src/screen/widgets/composerFloor.ts src/screen/widgets/faces/** src/screen/widgets/focalRamp.ts src/screen/widgets/footerHint.ts src/screen/widgets/geometry.ts src/screen/widgets/keyHintLabel.ts src/screen/widgets/menuFold.tsx src/screen/widgets/navSemantics.ts src/screen/widgets/navigable-panes/** src/screen/widgets/needsYouJump.ts src/screen/widgets/paneWindow.ts src/screen/widgets/parity/** src/screen/widgets/sessionAccent.ts src/screen/widgets/splashRuns.ts src/screen/widgets/theme.ts src/screen/widgets/toolCardGrammar.ts src/screen/widgets/toolCardMeta.tsx src/screen/widgets/toolGlyphs.ts src/screen/widgets/useCursorFollow.ts src/screen/widgets/useElevatedSurface.ts src/screen/widgets/useFlatList.ts src/screen/widgets/useGreetingShimmer.ts src/screen/widgets/useHoverOwned.ts src/screen/widgets/useInteractiveList.ts src/screen/widgets/useMercuryTokens.ts src/screen/widgets/useNavigablePanes.ts src/screen/widgets/useOpenEventGate.ts src/screen/widgets/useSplashCoreAccent.ts src/screen/widgets/useStableSelection.ts
# gate-watch: src/boot/first-run/MercurySetupFrame.tsx src/commands/exit/MercuryExitConfirm.tsx src/commands/model/picker/MercuryModelPicker.tsx src/screen/chat/MercuryTurnRollup.tsx src/screen/composer/MercuryCommandPalette.tsx src/screen/composer/MercuryContentSearch.tsx src/screen/composer/MercuryFileOpen.tsx src/screen/composer/MercuryMissionIndicator.tsx src/screen/frame-chips/MercuryFrame.tsx src/screen/fullscreen-layout/MercuryFilesMenu.tsx src/screen/fullscreen-layout/MercuryHome.tsx src/screen/input-atlas/MercuryInputAtlas.tsx src/screen/messages/MercuryCompactSummary.tsx src/screen/scroll-keys/ScrollKeybindingHandler.tsx src/screen/session-chooser/SessionBrowser.tsx
# gate-watch: src/commands/critter/CritterSelect.tsx src/screen/composer/text-input/BaseTextInput.tsx src/screen/fullscreen-layout/FullscreenLayout.tsx
# gate-watch: src/screen/prompts-panel/PromptsPanel.tsx
# gate-watch: src/screen/select/useSelectNavigation.ts src/permissions/cards/ask-user-question/QuestionView.tsx
# gate-watch: src/commands/effort/effort.tsx src/screen/composer/text-input/useTextInput.ts
# gate-watch: src/screen/concourse/ConcourseRoute.tsx src/screen/renderer/terminal-session/capabilities.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/navigation-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'navigation-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members navigation-drives 'scripts/navigation/$name' "$here/members.txt"
