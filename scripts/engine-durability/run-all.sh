#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/run/** src/services/workbench/** src/query.ts
# gate-watch: src/substrate/serialGeneration.ts src/substrate/fileStore.ts
# gate-watch: src/substrate/durablePublish.ts src/run-core/turn-machine.ts
# ============================================================================
#  scripts/engine-durability/run-all.sh — state-integrity proofs.
#
#  Every proof here is a standing law over the live owners (the
#  serial-coalescing owner, the source-state vocabulary among them); there is
# no EXPECT-RED lane.
#
#  That lane was never a suppression. A reproducer parked as "known red" rots
#  silently, so the suite failed both if one stopped running AND if one started
#  passing while still listed there, which is what forced each fix to promote
#  its own reproducer in the same commit. Restore the lane only for a defect
#  whose fix is genuinely scheduled for a later stage — never to park a red.
#
#  Auto-joins scripts/run-all-suites.sh via its scripts/*/run-all.sh glob.
# ============================================================================
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# engine-durability — state integrity"
echo "############################################################"

# Fixed and pinned green.
for proof in prove-serial-lane prove-settlement-ordering prove-owner-teardown prove-terminal-drain prove-lock-contract prove-write-route-ratchet prove-group-commit prove-writer-epoch prove-projection-freshness prove-coalescer-owner prove-source-truth prove-source-vocabulary prove-engine-lifecycle prove-receipt-contract prove-run-revision-parity prove-sidecar-compat; do
  echo
  echo "── ${proof}.ts ──"
  __t=$SECONDS; "$bun" run "$here/${proof}.ts" || fail=1; prover_mark "$here/${proof}.ts" "$__t"
done

echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ENGINE-DURABILITY PASS"; else echo "# ❌ ENGINE-DURABILITY FAILED"; fi
echo "############################################################"
exit $fail
