#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/edit-tools/fixtures/**
# gate-watch: src/tools/FileReadTool/** src/tools/FileEditTool/**
# gate-watch: src/services/changeTransaction/** src/services/ide/** src/services/resources/**
# gate-watch: src/services/repoHost/** src/tools/GitTool/** src/tools/TestTool/** src/tools/LaunchTool/** src/utils/healthReport.ts
# ============================================================================
#  scripts/edit-tools/run-all.sh — the frontier utility workbench suite.
#
#  Members (globbed — new proofs auto-join):
#    prove-edit-tools-benchmark.ts  cpu — the §3 frozen-mission corpus is
#                              mechanically sound (8 missions through the
#                              real owner seams, zero false successes, zero
#                              unresolved refs) and the committed baseline
#                              projection has not drifted.
#
#  (bench-edit-tools.ts --write is the operator-run measurement CLI — it
#   regenerates scripts/edit-tools/fixtures/; the prover only READS the committed
#   projection. Billed model-driven passes stay out of the gate.)
# ============================================================================
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# edit-tools — utility workbench suite"
echo "############################################################"
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  echo ""
  echo "== $name =="
  __t=$SECONDS; if ! "$bun" "$f"; then
    echo "RED: $name"
    fail=1
  fi
  prover_mark "$f" "$__t"
done
exit "$fail"
