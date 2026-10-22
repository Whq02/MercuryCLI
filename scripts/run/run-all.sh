#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/config/globalConfig.ts
# gate-watch: src/services/run/**
# gate-watch: src/utils/cockpit/contextUsageLive*
# gate-watch: src/utils/cockpit/ctxForecast* src/utils/verification/verificationState*
# gate-watch: src/bootstrap/state.ts src/commands/run/runInspectorModel.ts src/chatLauncher.tsx
# gate-watch: src/screens/Chat.tsx src/guards/runStopAdapter.ts src/utils/tasks.ts
# gate-watch: src/cli/run.ts src/cli/structuredIO.ts src/cli/headless/turnDriver.ts src/cli/headless/runnerMethods.ts src/cli/headless/controlHandlers.ts
# gate-watch: src/rows/vocabulary.ts src/rows/turn.ts src/runner/wire/methods.ts src/runner/wire/errors.ts src/types/textInputTypes.ts
# gate-watch: src/services/schema/jsonSchemaEngine.ts src/guards/structuredOutput.ts src/utils/fileHistory.ts src/services/engine-connector/seatProjections.ts
# gate-watch: scripts/daemon/dupline-world.ts scripts/lib/fixtureApi.ts scripts/lib/runnerHost.ts scripts/lib/rows.ts scripts/lib/scriptedTurn.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# run — autonomous-run kernel proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
exit $fail
