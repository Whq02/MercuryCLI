#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/daemon/runner-wire/* src/engine/requests/dumpPrompts.ts src/engine/rows/*
# gate-watch: src/models/catalogue/modelTransition.ts src/models/roads/accountSlots.ts src/models/roads/anthropic/**
# gate-watch: src/models/roads/toolEconomy.ts src/models/sign-in/oauth/**
# gate-watch: src/permissions/guards/* src/platform/environment/platform.ts src/platform/health/sections/crew.ts
# gate-watch: scripts/daemon/dupline-world.ts scripts/lib/* scripts/ui/vshot.py
# gate-watch: src/screen/app-state/AppStateStore.ts
# gate-watch: src/screen/boot-face/*
# gate-watch: src/screen/composer/useComposerModelDoors.tsx
# gate-watch: src/screen/composer/useCrewBanner.ts src/screen/widgets/faces/*
# gate-watch: src/screen/widgets/parity/*
# gate-watch: src/sessions/mission-card/* src/sessions/resume/*
# gate-watch: src/tools/crewmate/crewmateColors.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/journey"
fail=0
drive_members journey 'scripts/journey/$name' "$here/members.txt" '' run || fail=1
if [ "$fail" -eq 0 ]; then echo "✅ JOURNEY SUITE GREEN"; else echo "❌ JOURNEY SUITE RED"; fi
exit "$fail"
