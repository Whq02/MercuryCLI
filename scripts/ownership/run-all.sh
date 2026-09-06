#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/config.ts src/utils/settings/** src/utils/permissions/** src/types/permissions.ts src/types/message.ts
# gate-watch: src/services/compact/** src/services/mcp/** src/services/tools/** src/services/run/effectObserver*
# gate-watch: src/query.ts src/QueryEngine.ts src/run-core/** src/cli/print.ts src/cli/headless/** src/cli/structuredIO.ts
# gate-watch: src/tools/AgentTool/AgentTool* src/utils/swarm/** src/main.tsx src/screens/REPL.tsx src/components/PromptInput/PromptInput*
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# ownership — core-ownership contract + journey harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
exit $fail
