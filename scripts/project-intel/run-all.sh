#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/project-intel/**
# gate-watch: src/services/projectIntel/** src/services/resources/adapters/project.ts
# gate-watch: src/utils/cockpit/repoSurfaceMap*
# ============================================================================
#  scripts/project-intel/run-all.sh — coherent project intelligence.
#
#  Members (globbed — new proofs auto-join):
#    prove-fixture-materialize.ts  cpu — the fixture estate the other members
#                             stand on: fixtures materialize outside the repo,
#                             git-clean at baseline; the ts fixture typechecks;
#                             the py fixture's unittest suite is green
#    prove-project-snapshot.ts · prove-context-capsule.ts · prove-impact-split.ts
#    prove-orient-surface.ts · prove-capsule-lifecycle.ts
#                             cpu — the project-intelligence owners (snapshot ·
#                             capsule · impact/split · orient · lifecycle) driven
#                             over the materialized ts fixture
#
#  gate-watch note: the project-intel src owners (project snapshot / context
#  capsule) join the watch lines above IN THE SAME CHANGE-SET as their first
#  src/ directory — scripts/project-intel/** self-watch is
#  implicit.
# ============================================================================
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Project intelligence — proof suite"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL PROJECT-INTEL PROOFS PASS"; else echo "# ❌ SOME PROJECT-INTEL PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
