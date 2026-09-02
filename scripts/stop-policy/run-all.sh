#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/run/** src/utils/hooks/missionHook* src/utils/hooks/unfinishedTail*
# gate-watch: src/utils/hooks/runStopAdapter* src/utils/hooks/runStopHook* src/utils/hooks/supervisorGate* src/query/stopHooks*
# gate-watch: src/utils/verification/verificationState* src/substrate/pidLock* src/QueryEngine*
# gate-watch: src/services/providers/openai/openaiWire* src/services/providers/openai/openaiCallModel*
# ============================================================================
#  scripts/stop-policy/run-all.sh — the persistence proof suite.
#  Evidence-gated persistence (laws S1–S8): the expect-red corpus pins the
#  defect classes both ways (green floors + required-red defect legs) and
#  Stage-2 slices flip legs green by moving them out of EXPECTED_RED in the
#  fixing commit. EXPLICIT list — new provers are added here deliberately.
# ============================================================================
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

PROOFS=(
  prove-persistence-corpus.ts
  prove-bm-classes.ts
  prove-progress-model.ts
  prove-prefix-fingerprint.ts
  prove-surface-sweep.ts
  prove-tool-delta-grammar.ts
  prove-print-phases.ts
  prove-supervisor-gate.ts
)

echo "############################################################"
echo "# stop-policy — evidence-gated persistence proof harness"
echo "############################################################"
for proof in "${PROOFS[@]}"; do
  echo
  echo "── $proof ──"
  __t=$SECONDS; "$bun" run "$here/$proof" || fail=1; prover_mark "$here/$proof" "$__t"
done
exit $fail
