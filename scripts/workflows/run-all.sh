#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/components/tasks/RunDetailPane* src/components/tasks/WorkflowDetailDialog*
# gate-watch: src/daemon/workerRecon* src/tasks/LocalWorkflowTask/LocalWorkflowTask*
# gate-watch: src/tools/WorkflowTool/** src/utils/evolution/evolutionLedger*
# Workflow-engine extensions — proof harness. Runs every scripts/workflows/prove-*.ts
# via bun run; non-zero exit on any failure. New proofs are picked up by the glob.
# (The core workflow-tool proofs live in scripts/tools/ — this suite holds the
#  fork's engine extensions: tier routing, …)
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Workflow engine extensions — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL WORKFLOW-EXTENSION PROOFS PASS"; else echo "# ❌ SOME WORKFLOW-EXTENSION PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
