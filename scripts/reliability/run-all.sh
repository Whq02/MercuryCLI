#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/bootstrap/state* src/commands/run/runInspectorModel* src/daemon/**
# gate-watch: src/services/run/** src/substrate/** src/utils/**
# gate-watch: scripts/reliability/gen-durable-matrix.ts
# Reliability — crash-consistent durable-state proof harness. Non-zero exit on any fail.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Reliability — durable-state crash-consistency harness"
echo "############################################################"
__t=$SECONDS; "$bun" run "$here/prove-durable-matrix.ts" || fail=1; prover_mark "$here/prove-durable-matrix.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-durable-publish.ts" || fail=1; prover_mark "$here/prove-durable-publish.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-store-revisions.ts" || fail=1; prover_mark "$here/prove-store-revisions.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-writer-sweep.ts" || fail=1; prover_mark "$here/prove-writer-sweep.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-operation-journal.ts" || fail=1; prover_mark "$here/prove-operation-journal.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-journal-live-sibling.ts" || fail=1; prover_mark "$here/prove-journal-live-sibling.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-recovery-orchestrator.ts" || fail=1; prover_mark "$here/prove-recovery-orchestrator.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-interruption-windows.ts" || fail=1; prover_mark "$here/prove-interruption-windows.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-artifact-faults.ts" || fail=1; prover_mark "$here/prove-artifact-faults.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-sync-spawn-bounds.ts" || fail=1; prover_mark "$here/prove-sync-spawn-bounds.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-crash-shutdown.ts" || fail=1; prover_mark "$here/prove-crash-shutdown.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-crash-report-identity.ts" || fail=1; prover_mark "$here/prove-crash-report-identity.ts" "$__t"
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL RELIABILITY PROOFS PASS"; else echo "# ❌ SOME RELIABILITY PROOFS FAILED"; fi
exit "$fail"
