#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/winreg/** scripts/ui/vshot.py scripts/lib/firstRunSeed.ts package.json src/daemon/runPtyHost.ts
# gate-watch: scripts/lib/captureDriver.ts scripts/switchboard/prove-session-unification.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
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
  if ! "$bun" run "$proof"; then
    fail=1
  fi
done

exit "$fail"
