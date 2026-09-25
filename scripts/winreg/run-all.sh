#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/winreg/** scripts/ui/vshot.py scripts/lib/firstRunSeed.ts package.json src/daemon/runPtyHost.ts
# gate-watch: scripts/lib/captureDriver.ts scripts/switchboard/prove-session-unification.ts
# gate-watch: scripts/engine-durability/harness.ts scripts/lib/capturePreflight.ts scripts/ui/render-tui.ts
# gate-watch: src/Task.ts src/Tool.ts src/bootstrap/state.ts src/cli/structuredIO.ts src/daemon/*
# gate-watch: src/hooks/useSkillsChange.ts src/native-ts/file-index/index.ts
# gate-watch: src/services/privateChannel/installLayout.ts src/services/privateChannel/updateService.ts
# gate-watch: src/utils/* src/utils/config/globalConfig.ts src/utils/permissions/filesystem.ts
# gate-watch: src/utils/secureStorage/plainTextStorage.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/proof-runner.sh"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# WINREG — Windows capture plane (local provable half)"
echo "############################################################"

for proof in "$here"/prove-*.ts; do
  [ -e "$proof" ] || continue
  name="$(basename "$proof")"
  case "$name" in _*) continue ;; esac
  echo ""
  echo "── $name"
  if ! run_proof "$proof" "$bun" run "$proof"; then
    fail=1
  fi
done

exit "$fail"
