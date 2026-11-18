#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/ui/vshot.py package.json
# gate-watch: scripts/lib/captureDriver.ts scripts/lib/capture_refusal.py scripts/switchboard/prove-session-unification.ts
# gate-watch: scripts/lib/capturePreflight.ts scripts/ui/render-tui.ts
# gate-watch: src/daemon/*
# gate-watch: src/utils/*
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/utils/health/sections/crew.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
. "$(dirname "$0")/../lib/proof-runner.sh"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# WINREG — Windows capture plane (local provable half)"
echo "############################################################"

claimed=$(cd "$here/../.." && members_cat scripts/winreg-*/members.txt)
for proof in "$here"/prove-*.ts; do
  printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")" && continue
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
