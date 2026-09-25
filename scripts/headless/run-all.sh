#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/Tool* src/bootstrap/state* src/cli/print* src/cli/structuredIO*
# gate-watch: src/utils/hooks/sessionHooks* src/QueryEngine*
# gate-watch: src/utils/sdkEventQueue* src/utils/task/sdkAgentFrames* src/tools/AgentTool/foregroundExecution* src/tools/AgentTool/agentToolUtils* src/cost-tracker*
# gate-watch: scripts/daemon/dupline-world.ts scripts/lib/* src/cli/headless/turnDriver.ts
# gate-watch: src/entrypoints/sdk/* src/input-core/command-queue.ts src/services/api/withRetry.ts
# gate-watch: src/services/browser/browserResolver.ts src/services/compact/foldStatus.ts
# gate-watch: src/services/engine-connector/seatWire.ts src/services/mcp/client.ts src/services/mcp/types.ts
# gate-watch: src/services/providers/busyRetry.ts src/services/providers/streamIdleBudget.ts
# gate-watch: src/services/run/effectObserver.ts src/services/tools/toolExecution.ts src/utils/*
# gate-watch: src/utils/config/globalConfig.ts src/utils/messages/mappers.ts
# gate-watch: src/utils/messages/rejectionText.ts src/utils/processUserInput/processUserInput.ts
# gate-watch: src/utils/task/framework.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# headless — control protocol + batching laws"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
exit $fail
