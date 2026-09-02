#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/daemon/scribeDispatchBridge*
# gate-watch: src/substrate/routerRunStore* src/tools/SendMessageTool/routePlanOps*
# gate-watch: src/utils/model/** src/utils/router/** src/utils/scribe/dispatchRouter*
# gate-watch: src/utils/scribe/scribeBus* src/utils/teammateMailbox*
# Mercury router fabric — proof harness. Runs every scripts/router/
# prove-*.ts via bun run; non-zero exit on any failure. New proofs are picked
# up by the glob; the pooled green gate (scripts/run-all-suites.sh) picks THIS
# suite up by ITS glob.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
# SUITE-LEVEL ISOLATION: every proof runs
# against a scratch route-state root and with the evolution ledger OFF, so a
# gate run can never seed the operator's live route/outcome stores with
# fixture rows. A proof needing different isolation sets its own env inside.
export MERCURY_EVOLUTION_LEDGER=0
scratch_state="$(mktemp -d "${TMPDIR:-/tmp}/router-proof-state.XXXXXX")"
export MERCURY_ROUTER_STATE_DIR="$scratch_state"
trap 'rm -rf "$scratch_state"' EXIT
echo "############################################################"
echo "# Router fabric — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL ROUTER PROOFS PASS"; else echo "# ❌ SOME ROUTER PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
