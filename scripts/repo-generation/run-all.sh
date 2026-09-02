#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/substrate/flagRegistry* src/substrate/themis/workflowHost* src/tools/**
# DAEDALUS — CodeTeam repo generation on the THEMIS control plane (paper-triad
# Slice C). Gate-safe: NO live API — the pipeline is proved by stub-agent dry
# runs through the REAL executor + the real themis host; the billed live E2E
# is scripts/repo-generation/live-repogen.sh (OPERATOR-RUN, never in the gate — the
# operator-run live-script precedent). Non-zero exit on any fail. Explicit list —
# wire NEW proofs in here (suites are explicit lists).
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# DAEDALUS repo-generation workflow — proof harness"
echo "############################################################"
__t=$SECONDS; "$bun" run "$here/prove-repo-generation-host.ts" || fail=1; prover_mark "$here/prove-repo-generation-host.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-repo-generation-script.ts" || fail=1; prover_mark "$here/prove-repo-generation-script.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-repo-generation-registration.ts" || fail=1; prover_mark "$here/prove-repo-generation-registration.ts" "$__t"
if [ "$fail" -ne 0 ]; then
  echo "❌ repo-generation suite: FAILURES"
  exit 1
fi
echo "✅ repo-generation suite: ALL GREEN"
