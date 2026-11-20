#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/wallet/** src/utils/secureStorage/**
# gate-watch: src/services/providers/credentialIdentity* src/services/providers/*/*Accounts.ts src/services/providers/*/*Login.ts src/services/oauth/** src/utils/accounts/**
# gate-watch: src/ink/stringWidth.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/wallet"
fail=0
drive_members wallet 'scripts/wallet/$name' "$here/members.txt" || fail=1
if [ "$fail" = "0" ]; then echo "✅ WALLET SUITE GREEN"; else echo "❌ WALLET SUITE RED"; fi
exit "$fail"
