#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/components/mercury-ui/toolCardGrammar* src/ink/**
# gate-watch: src/services/agentResults/normalize* src/services/changeTransaction/receipts*
# gate-watch: src/services/changeTransaction/snapshotAnchor* src/services/dap/dapClient*
# gate-watch: src/services/lsp/LSPServerInstance* src/services/primitives/**
# gate-watch: src/services/projectServices/executionProjection*
# gate-watch: src/services/projectServices/serviceManager*
# gate-watch: src/services/resources/adapters/service* src/services/resources/contracts*
# gate-watch: src/services/resources/registry* src/services/run/** src/services/workshop/**
# gate-watch: src/utils/task/executionProjection* src/utils/task/framework*
# gate-watch: src/utils/verification/verificationState*
# proof harness.
# cross-domain characterization + census drift. Later slices add
# their prove-*.ts here by the glob; run-all-suites.sh auto-joins this suite
# via its scripts/*/run-all.sh glob.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# primitives-kernel — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo
echo ">>> render-primitives-kernel-cards.tsx (primitive state matrix, real PTY grid)"
__t=$SECONDS; UI_RENDER=1 "$bun" run "$here"/render-primitives-kernel-cards.tsx || fail=1; prover_mark "$here"/render-primitives-kernel-cards.tsx "$__t"
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL primitives-kernel PROOFS PASS"; else echo "# ❌ SOME primitives-kernel PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
