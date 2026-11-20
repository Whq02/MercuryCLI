#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/usageHistory.ts src/cli/handlers/usageHistory.ts src/main.tsx scripts/lib/spawnCapture.ts
# gate-watch: src/utils/modelCost.ts src/services/providers/deepseek/deepseekPins.ts src/services/providers/providerUsage.ts
# gate-watch: scripts/ui/gridToPng.ts scripts/ui/vshot.py src/utils/sessionStorage/transcriptReader.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
cd "$(dirname "$0")/../.." || exit 1
here="scripts/usage"
fail=0
drive_members usage 'scripts/usage/$name' "$here/members.txt" || fail=1
exit "$fail"
