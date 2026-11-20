#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/mneme/** src/utils/backgroundHousekeeping* src/query/stopHooks*
# gate-watch: src/tools/JournalTool/** src/main.tsx
# gate-watch: src/utils/gracefulShutdown.ts src/utils/fileHistory.ts
# gate-watch: src/utils/sessionStorage/transcriptReader.ts src/fabric/transcriptDecode.ts
# gate-watch: src/components/ExitFlow.tsx
# gate-watch: src/services/engine-connector/types.ts
# gate-watch: src/daemon/workerIdentity.ts
# gate-watch: src/run-core/turn/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for proof in \
  prove-topic-memory-discoverability.ts \
  prove-topic-memory-correction.ts \
  prove-topic-memory-maintenance.ts \
  prove-memory-refs.ts \
  prove-lineage-ledger.ts \
  prove-ledger-torn-tail.ts \
  prove-live-session-identity.ts \
  prove-lineage-session.ts \
  prove-lineage-interrupted.ts \
  prove-handoff-tool-wall.ts \
  prove-handoff-write-receipt.ts \
  prove-handoff-final-reply.ts \
  prove-handoff-verbatim.ts \
  prove-handoff-novelty.ts \
  prove-handoff-low-effort.ts \
  prove-lineage-retention-zero.ts \
  prove-exit-handoff.ts \
  prove-exit-engine-gone.ts \
  prove-exit-hosted-road.ts \
  prove-ephemeral-leaves-nothing.ts \
  prove-entry-page-journal-label.ts \
  prove-entry-state.ts \
  prove-entry-knapsack.ts \
  prove-entry-task-continuation.ts \
  prove-entry-stale-wiring.ts \
  prove-wording-fixes.ts \
; do
  echo "── $proof"
  __t=$SECONDS; __rc=0; if ! { "$BUN" run "$here/$proof"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    echo "❌ $proof FAILED"
    fail=1
  fi
  prover_mark "$here/$proof" "$__t" "$__rc"
done
if [ "$fail" -ne 0 ]; then
  echo "❌ memory-lifecycle suite: FAILURES"
  exit 1
fi
echo "✅ memory-lifecycle suite: ALL GREEN"
