#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/ast-tools/**
# gate-watch: src/utils/astPatterns.ts src/tools/AstSearchTool/** src/tools/AstEditTool/**
# gate-watch: src/services/structure/pattern.ts src/services/structure/polyglotQuery.ts src/services/structure/grammarFacility.ts
# ============================================================================
#  scripts/ast-tools/run-all.sh — the structural search/edit tools suite.
#
#  Members (globbed — new proofs auto-join):
#    prove-ast-search.ts   cpu — AstSearch over a fixture per supported
#                          language: $ and $$$ captures, count mode, glob
#                          scoping, the bound + paging, the unsupported-
#                          language refusal, the malformed-pattern error
#                          text, the zero-match census, parse honesty, the
#                          read-deny skip, the descriptions' pins.
#    prove-ast-edit.ts     cpu — AstEdit through the REAL tool door
#                          (runToolUse): dry-run diff + plan token with
#                          zero writes, the permission ask observed at the
#                          canUseTool seam, deny/allow rules, the stale-plan
#                          refusal, apply through the shared commit walk with
#                          re-read verification, the change receipt, the
#                          layout-keeping lane, the deletion law, the
#                          ambiguous-rewrite refusals, /rewind restoring.
#    prove-ast-parity.ts   cpu — the pin: an edit's match set is exactly the
#                          search's match set for the same pattern and scope.
#
#  The engine dir is composed per prover from BOTH vendored sources (the
#  @vscode pack in node_modules + the lock-pinned grammar-pack cache) so every
#  registry language is exercised; a grammar absent from this checkout is a
#  named [SKIP], never a silent pass.
# ============================================================================
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# ast-tools — structural search and edit"
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
