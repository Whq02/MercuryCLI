#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/editor-bridge/**
# gate-watch: src/services/workbench/** src/services/resources/adapters/workbench.ts
# gate-watch: src/services/acp/** src/services/workContexts/** src/services/walkthrough/**
# gate-watch: src/utils/artifacts/** src/components/diff/** src/components/prompts-panel/**
# ============================================================================
#  scripts/editor-bridge/run-all.sh — the unified agent workbench,
#  artifact review and editor bridge.
#
#  Members (globbed — new proofs auto-join):
#    prove-workbench-projection.ts  cpu — S1: pure selectors (root+children,
#                                   lanes, next-action ladder), engine laws
#                                   (flag gate, stable reference), the
#                                   mercury://workbench adapter through the
#                                   real registry.
# ============================================================================
set -u

# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

bun=${BUN:-$HOME/.bun/bin/bun}
cd "$(dirname "$0")/../.." || exit 1

red=0
for proof in scripts/editor-bridge/prove-*.ts; do
  echo "== $proof"
  __t=$SECONDS; if ! "$bun" run "$proof"; then
    echo "RED: $proof"
    red=1
  fi
  prover_mark "$proof" "$__t"
done

exit "$red"
