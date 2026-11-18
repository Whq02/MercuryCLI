#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/usage/**
# gate-watch: src/utils/usageHistory.ts src/cli/handlers/usageHistory.ts src/main.tsx src/cost-tracker.ts scripts/lib/spawnCapture.ts
# gate-watch: src/utils/modelCost.ts src/services/providers/deepseek/deepseekPins.ts src/services/providers/providerUsage.ts
# gate-watch: src/services/providers/openaicompat/compatChatCallModel.ts src/utils/sessionStorage/usageRollup.ts
# gate-watch: scripts/ui/gridToPng.ts scripts/ui/vshot.py src/Tool.ts src/services/providers/deepseek/deepseekCallModel.ts src/utils/messages.ts src/utils/sessionStorage/transcriptReader.ts src/utils/sessionStorage/vnext.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/usage-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'usage-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members usage-drives 'scripts/usage/$name' "$here/members.txt"
