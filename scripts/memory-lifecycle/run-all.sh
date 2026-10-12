#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/mneme/** src/utils/backgroundHousekeeping* src/query/stopHooks* src/services/projectIntel/capsule.ts
# gate-watch: src/constants/prompts.ts src/run-core/turn-machine.ts src/utils/gracefulShutdown.ts src/utils/fileHistory.ts
# gate-watch: src/bootstrap/state.ts src/input-core/command-queue.ts scripts/lib/fixtureApi.ts scripts/lib/firstRunSeed.ts scripts/lib/rows.ts
# gate-watch: src/components/ExitHandoff.tsx src/commands/exit/exit.tsx src/components/ExitFlow.tsx src/utils/forkedAgent.ts src/utils/config/globalConfig.ts scripts/lib/settingsPopupHarness.ts
# gate-watch: src/components/design-system/ThemeProvider.tsx src/ink.ts
# gate-watch: src/daemon/ownerWatch.ts src/daemon/workerIdentity.ts src/utils/settings/settings.ts
# gate-watch: src/services/tools/toolHooks.ts src/state/AppStateStore.ts src/utils/fileStateCache.ts src/utils/messages/factories.ts
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
  prove-handoff-tool-wall.ts \
  prove-handoff-write-receipt.ts \
  prove-handoff-final-reply.ts \
  prove-handoff-verbatim.ts \
  prove-lineage-retention-zero.ts \
  prove-exit-handoff.ts \
  prove-ephemeral-leaves-nothing.ts \
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
