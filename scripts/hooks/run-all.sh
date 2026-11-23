#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/hooks"
fail=0
echo "── hooks proofs ──"
drive_members hooks 'scripts/hooks/$name' "$here/members.txt" || fail=1
if [[ "$fail" == "0" ]]; then echo "✅ HOOKS SUITE GREEN"; exit 0; else
  echo "❌ HOOKS SUITE RED"; exit 1; fi
