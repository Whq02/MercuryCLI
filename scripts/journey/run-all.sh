#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/permissions/guards/mission.ts src/sessions/mission-card/missionCard.ts src/sessions/resume/sessionRestore.ts
# gate-watch: src/models/roads/anthropic/anthropicAdapter.ts src/models/roads/anthropic/anthropicCatalogue.ts src/models/roads/anthropic/anthropicClient.ts src/models/roads/anthropic/anthropicLogin.ts src/models/roads/anthropic/anthropicStream.ts src/models/roads/anthropic/anthropicUsageState.ts src/models/roads/anthropic/anthropicWorkspace.ts src/models/roads/anthropic/boundPrefixRecord.ts src/models/roads/anthropic/cacheAndUsage.ts src/models/roads/anthropic/cacheDiagnostics.ts src/models/roads/anthropic/index.ts src/models/roads/anthropic/media.ts src/models/roads/anthropic/messageEffort.ts src/models/roads/anthropic/messageParams.ts src/models/roads/anthropic/modelRefusal.ts src/models/roads/anthropic/prefixLedger.ts src/models/roads/anthropic/prefixRecordStore.ts src/models/roads/anthropic/requestParams.ts src/models/roads/anthropic/stream-core/** src/models/roads/anthropic/streamCore.ts src/models/roads/anthropic/thinkingBinding.ts src/models/roads/anthropic/thinkingDisplay.ts src/models/roads/anthropic/toolIds.ts src/models/roads/toolEconomy.ts src/engine/requests/dumpPrompts.ts
# gate-watch: src/screen/widgets/parity/AccountView.tsx src/models/roads/accountSlots.ts
# gate-watch: src/screen/widgets/faces/anthropicLoginModel.ts src/models/sign-in/oauth/auth-code-listener.ts src/models/sign-in/oauth/client.ts src/models/sign-in/oauth/crypto.ts src/models/sign-in/oauth/index.ts src/models/sign-in/oauth/refresh.ts src/screen/boot-face/BootLoginsScreen.tsx
# gate-watch: scripts/daemon/dupline-world.ts scripts/lib/* scripts/ui/vshot.py
# gate-watch: src/screen/composer/useCrewBanner.ts
# gate-watch: src/screen/app-state/AppStateStore.ts
# gate-watch: src/tools/crewmate/crewmateColors.ts
# gate-watch: src/engine/rows/* src/daemon/runner-wire/*
# gate-watch: src/platform/environment/platform.ts
# gate-watch: src/models/catalogue/modelTransition.ts src/screen/composer/useComposerModelDoors.tsx
# gate-watch: src/platform/health/sections/crew.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/journey"
fail=0
drive_members journey 'scripts/journey/$name' "$here/members.txt" '' run || fail=1
if [ "$fail" -eq 0 ]; then echo "✅ JOURNEY SUITE GREEN"; else echo "❌ JOURNEY SUITE RED"; fi
exit "$fail"
