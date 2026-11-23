#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── turn-engine proofs ──"
drive_members turnEngine 'scripts/turnEngine/$name' "$here/members.txt" || fail=1
"${BUN:-$HOME/.bun/bin/bun}" -e "
await import('$here/../../src/engine/turnDoor.ts')
await import('$here/../../src/engine/rows/turn.ts')
console.log('  [PASS] both turn-engine modules bun-load')
" || { echo "  [FAIL] loadability probe"; fail=1; }
if [[ "$fail" == "0" ]]; then echo "✅ TURNENGINE SUITE GREEN"; exit 0; else
  echo "❌ TURNENGINE SUITE RED"; exit 1; fi
