#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/guards/mission* src/utils/mission/missionCard* src/services/resume/sessionRestore*
# gate-watch: src/services/providers/anthropic/** src/services/providers/toolEconomy.ts src/services/api/dumpPrompts.ts
# gate-watch: src/components/mercury-ui/parity/AccountView* src/services/providers/accountSlots.ts
# gate-watch: src/components/mercury-ui/screens/anthropicLoginModel* src/services/oauth/** src/components/BootLoginsScreen*
# gate-watch: scripts/daemon/dupline-world.ts scripts/lib/* scripts/ui/vshot.py
# gate-watch: src/components/PromptInput/useCrewBanner.ts
# gate-watch: src/state/AppStateStore.ts
# gate-watch: src/tools/AgentTool/agentColorManager.ts
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/utils/platform.ts
# gate-watch: src/commands/model/model.tsx src/services/model/modelTransition.ts src/components/PromptInput/useComposerModelDoors.tsx
# gate-watch: src/services/health/sections/crew.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/journey"
fail=0
drive_members journey 'scripts/journey/$name' "$here/members.txt" '' run || fail=1
if [ "$fail" -eq 0 ]; then echo "✅ JOURNEY SUITE GREEN"; else echo "❌ JOURNEY SUITE RED"; fi
exit "$fail"
