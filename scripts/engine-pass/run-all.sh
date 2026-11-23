#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/screen/renderer/staticRender.tsx src/screen/widgets/AnimatedCritterArt.tsx src/screen/widgets/CritterArt.tsx src/screen/widgets/CursorRow.tsx src/screen/widgets/EffortChip.tsx src/screen/widgets/EffortStrip.tsx src/screen/widgets/FailoverMark.tsx src/screen/widgets/InteractiveDisclosure.tsx src/screen/widgets/InteractiveRow.tsx src/screen/widgets/LiveGlyphs.tsx src/screen/widgets/MiniCritter.tsx src/screen/widgets/NavigablePanes.tsx src/screen/widgets/PaletteView.tsx src/screen/widgets/RailPanel.tsx src/screen/widgets/SceneCanvas.tsx src/screen/widgets/TrimChip.tsx src/screen/widgets/WorkCapsule.tsx src/screen/widgets/appearanceSnapshot.ts src/screen/widgets/assets.tsx src/screen/widgets/compactModeChip.ts src/screen/widgets/components.tsx src/screen/widgets/composerFloor.ts src/screen/widgets/faces/** src/screen/widgets/focalRamp.ts src/screen/widgets/footerHint.ts src/screen/widgets/geometry.ts src/screen/widgets/keyHintLabel.ts src/screen/widgets/menuFold.tsx src/screen/widgets/navSemantics.ts src/screen/widgets/navigable-panes/** src/screen/widgets/needsYouJump.ts src/screen/widgets/paneWindow.ts src/screen/widgets/parity/** src/screen/widgets/sessionAccent.ts src/screen/widgets/splashRuns.ts src/screen/widgets/theme.ts src/screen/widgets/toolCardGrammar.ts src/screen/widgets/toolCardMeta.tsx src/screen/widgets/toolGlyphs.ts src/screen/widgets/useCursorFollow.ts src/screen/widgets/useElevatedSurface.ts src/screen/widgets/useFlatList.ts src/screen/widgets/useGreetingShimmer.ts src/screen/widgets/useHoverOwned.ts src/screen/widgets/useInteractiveList.ts src/screen/widgets/useMercuryTokens.ts src/screen/widgets/useNavigablePanes.ts src/screen/widgets/useOpenEventGate.ts src/screen/widgets/useSplashCoreAccent.ts src/screen/widgets/useStableSelection.ts assets/splash/**
# gate-watch: scripts/ui/** scripts/critters/fixtures/** scripts/critters/zzzFrames.ts scripts/engine-connector/fixtures/**
# gate-watch: design-system/live/** scripts/lib/ptyRecorder.ts scripts/lib/distProvenance.ts
# gate-watch: scripts/engine-connector/prove-crew-token-rows.ts scripts/critters/prove-critter-sleep.ts scripts/visual-contract/baseline-capture.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
cd "$(dirname "$0")/../.." || exit 1
here="scripts/engine-pass"
fail=0
drive_members engine-pass 'scripts/engine-pass/$name' "$here/members.txt" || fail=1
exit "$fail"
