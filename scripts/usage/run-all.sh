#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/usageHistory.ts src/cli/handlers/usageHistory.ts src/main.tsx scripts/lib/spawnCapture.ts
# gate-watch: src/utils/modelCost.ts src/services/providers/deepseek/deepseekPins.ts src/services/providers/providerUsage.ts
# gate-watch: scripts/ui/gridToPng.ts scripts/ui/vshot.py src/utils/sessionStorage/transcriptReader.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
claimed=$(cd "$here/../.." && members_cat scripts/usage-*/members.txt)
for proof in "$here"/prove-*.ts; do
  printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")" && continue
  start=$SECONDS; rc=0
  "$bun" run "$proof" || { rc=$?; fail=1; }
  printf '%s %ss rc=%s\n' "$(basename "$proof")" "$((SECONDS - start))" "$rc"
done
exit "$fail"
