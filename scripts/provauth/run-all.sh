#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/provauth"
fail=0
export MERCURY_EVOLUTION_LEDGER=0
echo "############################################################"
echo "# PROVAUTH — provider auth proof harness"
echo "############################################################"
drive_members provauth 'scripts/provauth/$name' "$here/members.txt" || fail=1
echo ""
if [ "$fail" -gt 0 ]; then
  echo "❌ provauth suite: $fail prover(s) red"
  exit 1
fi
echo "✅ provauth suite green"
