#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/Task* src/Tool* src/commands/branch/branch* src/constants/subagentDoctrine*
# gate-watch: src/ink/** src/services/agentResults/** src/services/changeTransaction/**
# gate-watch: src/services/contextLanes/lanes* src/services/counsel/counsel*
# gate-watch: src/services/projectServices/serviceManager* src/services/resources/adapters/lane*
# gate-watch: src/services/resources/contracts* src/services/resources/registry*
# gate-watch: src/services/run/** src/services/tools/toolExecution*
# gate-watch: src/services/workshop/pythonRuntime* src/services/workshop/runtime*
# gate-watch: src/tasks/LocalAgentTask/LocalAgentTask* src/tools/** src/utils/artifacts/store*
# gate-watch: src/utils/messageQueueManager* src/utils/messages/attachmentText* src/utils/tasks*
# gate-watch: src/utils/verification/verificationState*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# project-services — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo
echo ">>> render-project-services-cards.tsx (shared card grammar, real PTY grid)"
__t=$SECONDS; __rc=0; UI_RENDER=1 "$bun" run "$here"/render-project-services-cards.tsx || { __rc=$?; fail=1; }; prover_mark "$here"/render-project-services-cards.tsx "$__t" "$__rc"
echo
echo ">>> gen-completions --check (shell completions track the live CLI)"
"$bun" run "$here"/gen-completions.ts --check || { __rc=$?; fail=1; }
echo
echo ">>> inventory --check (surface superset)"
"$bun" run "$here"/inventory.ts --check || { __rc=$?; fail=1; }
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL project-services PROOFS PASS"; else echo "# ❌ SOME project-services PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
