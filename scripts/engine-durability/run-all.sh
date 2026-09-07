#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/run/** src/services/workbench/** src/query.ts
# gate-watch: src/substrate/serialGeneration.ts src/substrate/fileStore.ts
# gate-watch: src/substrate/durablePublish.ts src/run-core/turn-machine.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# engine-durability — state integrity"
echo "############################################################"

for proof in prove-serial-lane prove-settlement-ordering prove-owner-teardown prove-terminal-drain prove-lock-contract prove-write-route-ratchet prove-group-commit prove-writer-epoch prove-projection-freshness prove-coalescer-owner prove-source-truth prove-source-vocabulary prove-engine-lifecycle prove-receipt-contract prove-run-revision-parity prove-sidecar-compat; do
  echo
  echo "── ${proof}.ts ──"
  __t=$SECONDS; "$bun" run "$here/${proof}.ts" || fail=1; prover_mark "$here/${proof}.ts" "$__t"
done

echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ENGINE-DURABILITY PASS"; else echo "# ❌ ENGINE-DURABILITY FAILED"; fi
echo "############################################################"
exit $fail
