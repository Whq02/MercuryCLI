#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/models/roads/** src/models/sign-in/account-ledger/**
# gate-watch: src/models/sign-in/oauth/** src/models/wallet/** src/platform/secure-storage/** src/screen/renderer/stringWidth.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/wallet"
fail=0
drive_members wallet 'scripts/wallet/$name' "$here/members.txt" || fail=1
if [ "$fail" = "0" ]; then echo "✅ WALLET SUITE GREEN"; else echo "❌ WALLET SUITE RED"; fi
exit "$fail"
