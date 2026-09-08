#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/bootstrap/state* src/commands/run/runInspectorModel* src/daemon/**
# gate-watch: src/services/run/** src/substrate/** src/utils/**
# gate-watch: scripts/reliability/gen-durable-matrix.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Reliability — durable-state crash-consistency harness"
echo "############################################################"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-durable-matrix.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-durable-matrix.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-durable-publish.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-durable-publish.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-store-revisions.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-store-revisions.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-writer-sweep.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-writer-sweep.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-operation-journal.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-operation-journal.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-journal-live-sibling.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-journal-live-sibling.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-recovery-orchestrator.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-recovery-orchestrator.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-interruption-windows.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-interruption-windows.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-artifact-faults.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-artifact-faults.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-sync-spawn-bounds.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-sync-spawn-bounds.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-crash-shutdown.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-crash-shutdown.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-crash-report-identity.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-crash-report-identity.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-write-keeps-old-bytes.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-write-keeps-old-bytes.ts" "$__t" "$__rc"
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL RELIABILITY PROOFS PASS"; else echo "# ❌ SOME RELIABILITY PROOFS FAILED"; fi
exit "$fail"
