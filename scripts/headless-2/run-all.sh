#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/headless/**
# gate-watch: src/bootstrap/state* src/cli/run* src/cli/structuredIO*
# gate-watch: src/utils/hooks/sessionHooks* src/rows/turn.ts
# gate-watch: src/utils/sdkEventQueue* src/utils/task/sdkAgentFrames* src/tools/AgentTool/foregroundExecution* src/tools/AgentTool/agentToolUtils* src/cost-tracker*
# gate-watch: scripts/lib/* src/cli/headless/hostAskLiveness.ts src/cli/headless/runnerAsks.ts src/cli/headless/runnerMethods.ts
# gate-watch: src/services/api/emptyUsage.ts
# gate-watch: src/services/compact/foldStatus.ts src/services/compact/compact.ts
# gate-watch: src/services/mcp/types.ts
# gate-watch: src/utils/*
# gate-watch: src/utils/processUserInput/processUserInput.ts
# gate-watch: src/setup.ts src/cli/runArgs.ts src/cli/sessionArgs.ts src/state/onChangeAppState.ts src/utils/permissions/rootNotice.ts
# gate-watch: src/services/instructions/** src/utils/processUserInput/** src/utils/config/trust.ts
# gate-watch: src/services/providers/openaicompat/**
# gate-watch: src/services/providers/anthropic/cacheAndUsage.ts
# gate-watch: src/rows/* src/runner/wire/* src/query/transitions.ts src/utils/messages/turnCut.ts
# gate-watch: src/daemon/runnerConnection.ts src/daemon/headlessRun.ts src/services/acp/childSession.ts
# gate-watch: src/daemon/verbs.ts src/utils/settings/validationTips.ts
# gate-watch: sdk/src/rows.ts
# gate-watch: src/mneme/* src/types/textInputTypes.ts
# gate-watch: package.json
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/headless-2"

fail=0
names=()
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  names+=("$name")
done < "$here/members.txt"
if [ "${#names[@]}" -eq 0 ]; then
  echo "❌ headless-2: $here/members.txt names no prover — an empty slice is a red, never a vacuous green"
  fail=1
fi
for name in ${names[@]+"${names[@]}"}; do
  f="scripts/headless/$name"
  if [ ! -e "$f" ]; then
    echo "❌ headless-2: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    fail=1
    continue
  fi
  echo
  echo "── $name ──"
  __t=$SECONDS; __rc=0; "$bun" run "$f" || { __rc=$?; fail=1; }; prover_mark "$f" "$__t" "$__rc"
done
exit "$fail"
