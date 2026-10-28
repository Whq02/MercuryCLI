#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/tools/ComputerTool/** src/services/desktop/** src/components/permissions/ComputerPermissionRequest/** src/components/PromptInput/PromptInputFooterLeftSide* scripts/computer/prove-computer-*-drive.ts build.ts
# gate-watch: scripts/computer/computerDriveKit.ts scripts/computer/computerProofKit.ts scripts/computer/computerToolKit.ts scripts/lib/* scripts/computer-drives/** native/desktop/src/{mac,win,x11,lib}.rs
# gate-watch: scripts/computer/fixtures/two-displays.json src/utils/toolResultStorage.ts src/Tool.ts src/bootstrap/state.ts src/services/run/resolveOwner.ts src/utils/messages.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/computer-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'computer-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

failed=0
drive_members computer-drives 'scripts/computer/$name' "$here/members.txt" || failed=1
for proof in "$here"/prove-*.ts; do
  [ -f "$proof" ] || continue
  drive_member_run computer-drives "$proof" "$(basename "$proof")" || failed=1
done
exit "$failed"
