#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/screen/attention/actions.ts src/screen/attention/contracts.ts src/screen/attention/relations.ts src/screen/attention/statusFeed.ts src/screen/attention/store.ts src/screen/attention/viewModel.ts src/screen/workbench/** src/screen/composer/input-core/backslashContinuation.ts src/screen/composer/input-core/command-queue.ts src/screen/composer/input-core/composer-document.ts src/screen/composer/input-core/interruptArity.ts src/screen/composer/input-core/pending-input.ts src/screen/composer/input-core/sendNowChord.ts
# gate-watch: src/integrations/acp/** src/screen/tasks/BackgroundTask.tsx src/screen/tasks/BackgroundTaskStatus.tsx src/screen/tasks/BackgroundTasksDialog.tsx src/screen/tasks/CompactWorkSummary.tsx src/screen/tasks/CrewmateDetailDialog.tsx src/screen/tasks/ShellDetailDialog.tsx src/screen/tasks/ShellProgress.tsx src/screen/tasks/background-tasks/** src/screen/tasks/crewmateInterrupt.ts src/screen/tasks/crewmateQueue.ts src/screen/tasks/renderToolActivity.tsx src/screen/tasks/taskStatus.tsx src/screen/tasks/useCrewLedger.ts src/screen/tasks/useCrewmateModel.ts src/screen/tasks/useCrewmateTranscript.ts src/screen/tasks/useCrewmateView.ts src/screen/tasks/useFocusedWork.ts
# gate-watch: integrations/acp/README.md
# gate-watch: scripts/streaming/bench-stream-fluidity.ts
# gate-watch: src/boot/process-state/processState.ts
# gate-watch: src/screen/composer/Composer.tsx src/screen/widgets/AnimatedCritterArt.tsx src/screen/widgets/CritterArt.tsx src/screen/widgets/CursorRow.tsx src/screen/widgets/EffortChip.tsx src/screen/widgets/EffortStrip.tsx src/screen/widgets/FailoverMark.tsx src/screen/widgets/InteractiveDisclosure.tsx src/screen/widgets/InteractiveRow.tsx src/screen/widgets/LiveGlyphs.tsx src/screen/widgets/MiniCritter.tsx src/screen/widgets/NavigablePanes.tsx src/screen/widgets/PaletteView.tsx src/screen/widgets/RailPanel.tsx src/screen/widgets/SceneCanvas.tsx src/screen/widgets/TrimChip.tsx src/screen/widgets/WorkCapsule.tsx src/screen/widgets/appearanceSnapshot.ts src/screen/widgets/assets.tsx src/screen/widgets/compactModeChip.ts src/screen/widgets/components.tsx src/screen/widgets/composerFloor.ts src/screen/widgets/focalRamp.ts src/screen/widgets/footerHint.ts src/screen/widgets/geometry.ts src/screen/widgets/keyHintLabel.ts src/screen/widgets/menuFold.tsx src/screen/widgets/navSemantics.ts src/screen/widgets/needsYouJump.ts src/screen/widgets/paneWindow.ts src/screen/widgets/sessionAccent.ts src/screen/widgets/splashRuns.ts src/screen/widgets/theme.ts src/screen/widgets/toolCardGrammar.ts src/screen/widgets/toolCardMeta.tsx src/screen/widgets/toolGlyphs.ts src/screen/widgets/useCursorFollow.ts src/screen/widgets/useElevatedSurface.ts src/screen/widgets/useFlatList.ts src/screen/widgets/useGreetingShimmer.ts src/screen/widgets/useHoverOwned.ts src/screen/widgets/useInteractiveList.ts src/screen/widgets/useMercuryTokens.ts src/screen/widgets/useNavigablePanes.ts src/screen/widgets/useOpenEventGate.ts src/screen/widgets/useSplashCoreAccent.ts src/screen/widgets/useStableSelection.ts
# gate-watch: src/tools/kit/toolList.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/attention"
fail=0

echo "############################################################"
echo "# attention — the operator command surface"
echo "############################################################"

drive_members attention 'scripts/attention/$name' "$here/members.txt" || fail=1

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ attention PASS"; else echo "# ❌ attention FAILED"; fi
echo "############################################################"
exit "$fail"
