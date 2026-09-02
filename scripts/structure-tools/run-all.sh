#!/usr/bin/env bash
# gate-class: cpu

# gate-watch: src/services/structure/** src/tools/StructureTool/**
# gate-watch: src/services/repoHost/** src/services/gitGraph/** src/tools/GitTool/**
# gate-watch: src/services/ide/projectRunners.ts src/services/ide/pythonTests.ts src/tools/TestTool/**
# gate-watch: src/services/resources/adapters/repo.ts src/services/resources/adapters/git.ts src/services/resources/adapters/structure.ts
# ============================================================================
#  scripts/structure-tools/run-all.sh — frontier developer-tooling
#  bridge (polyglot Structure · repository observation · project checks).
#
#  Members (globbed — new proofs auto-join):
#    prove-polyglot-query.ts      cpu — pattern queries: mixed-language
#                                 inference, captures, ignore rules, caps,
#                                 determinism, per-file parse honesty.
#    prove-polyglot-transform.ts  cpu — rewrite previews/applies: digest
#                                 drift refusal, parse guard, overlap and
#                                 template refusals, evidence, exact writes.
#    prove-polyglot-parity.ts     cpu — MERCURY_STRUCTURE_POLYGLOT=0 restores
#                                 the baseline surface (fresh-process
#                                 schema probes — schemas are boot-latched).
#    prove-structure-tools-artifact.ts      cpu — the slices exist INSIDE the built
#                                 bundle; the vendored grammar engine parses
#                                 under stock node from the dist layout.
# ============================================================================
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# MERCURY structure-tools — developer-tooling bridge suite"
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
