#!/usr/bin/env bash
# gate-class: pty
# (this suite drives the BUILT dist through vshot (real PTY product boots); the class annotation lives on this line: the gate registry parses the header line as the bare class)
# gate-watch: scripts/winreg/** scripts/ui/vshot.py scripts/lib/firstRunSeed.ts package.json src/daemon/runPtyHost.ts
# gate-watch: scripts/lib/captureDriver.ts scripts/switchboard/prove-session-unification.ts
# ============================================================================
#  scripts/winreg/run-all.sh — the Windows capture plane's LOCAL proofs.
#
#  The behavioral captures need a real ConPTY and run on the dispatch-only
#  windows-ui workflow; what runs here is everything provable from any OS:
#  the node-pty root-manifest prohibition and the vshot grammar parity that
#  keeps Windows receipts comparable to POSIX ones.
#
#  Auto-joins scripts/run-all-suites.sh via its scripts/*/run-all.sh glob.
# ============================================================================
set -uo pipefail
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
