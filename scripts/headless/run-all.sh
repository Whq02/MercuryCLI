#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/cli/run*
# gate-watch: src/utils/permissions/permissionSetup.ts
# gate-watch: src/tools/AgentTool/foregroundExecution*
# gate-watch: scripts/lib/* src/cli/headless/hostAskLiveness.ts
# gate-watch: src/services/api/withRetry.ts
# gate-watch: src/services/browser/browserResolver.ts src/services/compact/compact.ts
# gate-watch: src/services/mcp/client.ts src/services/mcp/types.ts
# gate-watch: src/services/providers/busyRetry.ts src/services/providers/streamIdleBudget.ts
# gate-watch: src/services/run/effectObserver.ts src/utils/*
# gate-watch: src/utils/permissions/ruleReason.ts
# gate-watch: src/entrypoints/shellParentGuard.ts
# gate-watch: src/cli/runArgs.ts
# gate-watch: src/services/instructions/** src/utils/processUserInput/** src/utils/config/trust.ts
# gate-watch: src/tools/BashTool/pathValidation.ts src/utils/permissions/shellProtectedPaths.ts
# gate-watch: src/services/providers/openaicompat/**
# gate-watch: src/rows/* scripts/mcp/_fixture-estate-server.mjs
# gate-watch: src/daemon/verbs.ts src/utils/settings/validationTips.ts
# gate-watch: src/mneme/* src/types/textInputTypes.ts
# gate-watch: src/utils/messages/apiPlan.ts
# gate-watch: src/tools/ServiceTool/ServiceTool.ts
# gate-watch: src/services/providers/local/toolCallMarkup.ts src/services/providers/local/ollamaChatTransport.ts src/services/providers/emptyReply.ts src/services/api/errors.ts src/run-core/turn-machine.ts
# gate-watch: src/utils/sessionStorage/**
# gate-watch: src/utils/attachments/orchestrator.ts
# gate-watch: src/services/api/reconnectLadder.ts
# gate-watch: src/run-core/turn/**
# gate-watch: src/cli/headless/*
# gate-watch: src/cli/headless/boot/*
# gate-watch: src/utils/settings/changeDetector.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# headless — control protocol + batching laws"
echo "############################################################"
claimed=$(cat scripts/headless-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')
dupes=$(printf '%s\n' "$claimed" | sort | uniq -d)
if [ -n "$dupes" ]; then
  echo "❌ headless: prover(s) named by TWO sibling member lists (a double run across shards):"
  printf '%s\n' "$dupes" | sed 's/^/    /'
  fail=1
fi
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")" && continue
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
exit $fail
