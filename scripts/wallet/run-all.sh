#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/wallet/** src/services/providers/primaryBackend.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
__t=$SECONDS
"${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-wallet.ts" || { prover_mark "$here/prove-wallet.ts" "$__t"; echo "❌ WALLET SUITE RED"; exit 1; }
prover_mark "$here/prove-wallet.ts" "$__t"
echo "✅ WALLET SUITE GREEN"
