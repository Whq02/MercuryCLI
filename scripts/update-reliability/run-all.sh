#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/update-reliability/**
# gate-watch: src/services/privateChannel/** scripts/release/** scripts/updater/**
# gate-watch: .github/workflows/private-release.yml
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/proof-runner.sh"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# UPDATE-RELIABILITY — the private-channel field-fix lane"
echo "############################################################"

for proof in "$here"/prove-*.ts; do
  [ -e "$proof" ] || continue
  echo
  echo "── $(basename "$proof") ──"
  (cd "$repo" && run_proof "$proof" "$bun" run "$proof") || fail=1
done

for repro in "$here"/repro-*.ts; do
  [ -e "$repro" ] || continue
  echo
  echo "── $(basename "$repro") ──"
  (cd "$repo" && run_proof "$repro" "$bun" run "$repro") || fail=1
done

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ UPDATE-RELIABILITY PASS"; else echo "# ❌ UPDATE-RELIABILITY FAILED"; fi
echo "############################################################"
exit "$fail"
