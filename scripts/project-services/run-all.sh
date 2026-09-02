#!/usr/bin/env bash
# gate-class: pty
# (reclassified: render-project-services-cards.tsx drives a REAL PTY grid —
#  the cpu class hid that from the scheduler AND denied this suite the flake
#  law's one solo re-run when the render died silently under pool contention.)
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
# proof harness.
# contract characterization + inventory drift. Later slices add
# their prove-*.ts here by the glob; run-all-suites.sh auto-joins this suite
# via its scripts/*/run-all.sh glob.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

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
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo
echo ">>> render-project-services-cards.tsx (shared card grammar, real PTY grid)"
__t=$SECONDS; UI_RENDER=1 "$bun" run "$here"/render-project-services-cards.tsx || fail=1; prover_mark "$here"/render-project-services-cards.tsx "$__t"
echo
echo ">>> gen-completions --check (shell completions track the live CLI)"
"$bun" run "$here"/gen-completions.ts --check || fail=1
echo
echo ">>> inventory --check (surface superset)"
"$bun" run "$here"/inventory.ts --check || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL project-services PROOFS PASS"; else echo "# ❌ SOME project-services PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
