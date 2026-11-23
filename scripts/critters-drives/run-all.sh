#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/platform/config/**
# gate-watch: src/screen/cockpit/awaySummary.ts src/screen/cockpit/branchHeadSync.ts src/screen/cockpit/cockpitActivity.ts src/screen/cockpit/commandPopup.ts src/screen/cockpit/composerSeed.ts src/screen/cockpit/crewView.ts src/screen/cockpit/crewmateWords.ts src/screen/cockpit/critterData.ts src/screen/cockpit/critterGaze.ts src/screen/cockpit/critterIdle.ts src/screen/cockpit/critterVariant.ts src/screen/cockpit/deviceHeadroom.ts src/screen/cockpit/filesMenu.ts src/screen/cockpit/freshness.ts src/screen/cockpit/gitSnapshot.ts src/screen/cockpit/greetingShimmer.ts src/screen/cockpit/helmFocus.ts src/screen/cockpit/hoverOwner.ts src/screen/cockpit/inputSelectionBridge.ts src/screen/cockpit/liveGlyphs.ts src/screen/cockpit/modelPickerPopup.ts src/screen/cockpit/motionGovernor.ts src/screen/cockpit/motionSetting.ts src/screen/cockpit/oasisBg.ts src/screen/cockpit/pointerCell.ts src/screen/cockpit/pointerShape.ts src/screen/cockpit/popupOwnsKeys.ts src/screen/cockpit/promptProvenance.ts src/screen/cockpit/realConversation.ts src/screen/cockpit/recessBackdrop.ts src/screen/cockpit/repoSurfaceMap.ts src/screen/cockpit/runtimePosture.ts src/screen/cockpit/settingsPopup.ts src/screen/cockpit/toolVerb.ts src/screen/cockpit/traceSnapshot.ts src/screen/cockpit/turnReceipt.ts src/screen/cockpit/turnSignals.ts src/screen/cockpit/types.ts src/screen/cockpit/typingActivity.ts src/screen/cockpit/uiClock.ts src/screen/cockpit/usageActivity.ts src/screen/cockpit/warmBackground.ts src/screen/cockpit/wrapPlain.ts src/screen/cockpit/zenMode.ts
# gate-watch: src/screen/frame-chips/MercuryFrame.tsx src/screen/chat/MercuryTurnRollup.tsx src/commands/critter/** src/platform/settings/settingsSchema.ts
# gate-watch: scripts/critters/* scripts/lib/* scripts/ui/*
# gate-watch: src/platform/environment/platform.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/critters-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'critters-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members critters-drives 'scripts/critters/$name' "$here/members.txt"
