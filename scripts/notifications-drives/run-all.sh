#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/notifications/**
# gate-watch: src/crew/crewmates/activity.ts src/crew/crewmates/adapters/** src/crew/crewmates/agentLaunchPlan.ts src/crew/crewmates/agentTranscriptReader.ts src/crew/crewmates/capabilities.ts src/crew/crewmates/channelCommand.ts src/crew/crewmates/conversations.ts src/crew/crewmates/crewAccountChange.ts src/crew/crewmates/crewWorktreeReminder.ts src/crew/crewmates/crewmateModelWord.ts src/crew/crewmates/crewmateRecord.ts src/crew/crewmates/descriptor.ts src/crew/crewmates/dispatch.ts src/crew/crewmates/engineDispatch.ts src/crew/crewmates/graph.ts src/crew/crewmates/identity.ts src/crew/crewmates/inbox.ts src/crew/crewmates/obligations.ts src/crew/crewmates/obligationsBridge.ts src/crew/crewmates/projection.ts src/crew/crewmates/seatBridge.ts src/crew/crewmates/targetPicker.ts
# gate-watch: src/screen/widgets/AnimatedCritterArt.tsx src/screen/widgets/CritterArt.tsx src/screen/widgets/CursorRow.tsx src/screen/widgets/EffortChip.tsx src/screen/widgets/EffortStrip.tsx src/screen/widgets/FailoverMark.tsx src/screen/widgets/InteractiveDisclosure.tsx src/screen/widgets/InteractiveRow.tsx src/screen/widgets/LiveGlyphs.tsx src/screen/widgets/MiniCritter.tsx src/screen/widgets/NavigablePanes.tsx src/screen/widgets/PaletteView.tsx src/screen/widgets/RailPanel.tsx src/screen/widgets/SceneCanvas.tsx src/screen/widgets/TrimChip.tsx src/screen/widgets/WorkCapsule.tsx src/screen/widgets/appearanceSnapshot.ts src/screen/widgets/assets.tsx src/screen/widgets/compactModeChip.ts src/screen/widgets/components.tsx src/screen/widgets/composerFloor.ts src/screen/widgets/focalRamp.ts src/screen/widgets/footerHint.ts src/screen/widgets/geometry.ts src/screen/widgets/keyHintLabel.ts src/screen/widgets/menuFold.tsx src/screen/widgets/navSemantics.ts src/screen/widgets/needsYouJump.ts src/screen/widgets/paneWindow.ts src/screen/widgets/sessionAccent.ts src/screen/widgets/splashRuns.ts src/screen/widgets/theme.ts src/screen/widgets/toolCardGrammar.ts src/screen/widgets/toolCardMeta.tsx src/screen/widgets/toolGlyphs.ts src/screen/widgets/useCursorFollow.ts src/screen/widgets/useElevatedSurface.ts src/screen/widgets/useFlatList.ts src/screen/widgets/useGreetingShimmer.ts src/screen/widgets/useHoverOwned.ts src/screen/widgets/useInteractiveList.ts src/screen/widgets/useMercuryTokens.ts src/screen/widgets/useNavigablePanes.ts src/screen/widgets/useOpenEventGate.ts src/screen/widgets/useSplashCoreAccent.ts src/screen/widgets/useStableSelection.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/notifications-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'notifications-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members notifications-drives 'scripts/notifications/$name' "$here/members.txt"
