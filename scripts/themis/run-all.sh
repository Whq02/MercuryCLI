#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/tools/toolExecution* src/substrate/themis/**
# THEMIS — deterministic control plane proof harness (paper-triad Slice A).
# Adversarial by design: every proof red-teams its happy path (tamper classes,
# benign near-misses, OFF ⇒ byte-identical runtime probes). Non-zero exit on
# any fail. Explicit list — wire NEW proofs in here (the autocompact-
# verbatim-tail lesson: suites are explicit lists).
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# THEMIS control plane — proof harness"
echo "############################################################"
__t=$SECONDS; "$bun" run "$here/prove-blocklist.ts" || fail=1; prover_mark "$here/prove-blocklist.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-audit-chain.ts" || fail=1; prover_mark "$here/prove-audit-chain.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-integrity-drift.ts" || fail=1; prover_mark "$here/prove-integrity-drift.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-phases-trace.ts" || fail=1; prover_mark "$here/prove-phases-trace.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-sds-contract.ts" || fail=1; prover_mark "$here/prove-sds-contract.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-gate-wiring.ts" || fail=1; prover_mark "$here/prove-gate-wiring.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-kernel-cell-gate.ts" || fail=1; prover_mark "$here/prove-kernel-cell-gate.ts" "$__t"
if [ "$fail" -ne 0 ]; then
  echo "❌ themis suite: FAILURES"
  exit 1
fi
echo "✅ themis suite: ALL GREEN"
