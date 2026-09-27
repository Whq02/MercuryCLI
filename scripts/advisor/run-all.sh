#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/advisor/** src/utils/model/subModelSlots.ts src/utils/messages/noticeRows.ts src/utils/messages/text.ts src/utils/workloadContext.ts src/constants/querySource.ts
# gate-watch: src/tools/AskAdvisorTool/** src/cli/headless/turnDriver.ts src/tools/AgentTool/runAgent.ts src/tools/WorkflowTool/agentHooks.ts src/utils/attachments/queuedCommands.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
here="$(pwd)/scripts/advisor"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
export MERCURY_CREDENTIAL_STORE="${MERCURY_CREDENTIAL_STORE:-file}"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo
if [ "$fail" -eq 0 ]; then echo "ADVISOR SUITE GREEN"; else echo "ADVISOR SUITE RED"; fi
exit "$fail"
