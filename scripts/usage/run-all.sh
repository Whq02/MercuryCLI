#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/utils/usageHistory.ts src/cli/handlers/usageHistory.ts src/main.tsx src/cost-tracker.ts
# gate-watch: src/utils/modelCost.ts src/services/providers/deepseek/deepseekPins.ts src/services/providers/providerUsage.ts
# gate-watch: src/services/providers/openaicompat/compatChatCallModel.ts src/utils/sessionStorage/usageRollup.ts
# gate-watch: scripts/ui/gridToPng.ts scripts/ui/vshot.py src/Tool.ts src/services/providers/deepseek/deepseekCallModel.ts src/utils/messages.ts src/utils/sessionStorage/transcriptReader.ts src/utils/sessionStorage/vnext.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for proof in "$here"/prove-*.ts; do
  start=$SECONDS; rc=0
  "$bun" run "$proof" || { rc=$?; fail=1; }
  printf '%s %ss rc=%s\n' "$(basename "$proof")" "$((SECONDS - start))" "$rc"
done
exit "$fail"
