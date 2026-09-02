#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/structure/** src/tools/StructureTool/** build.ts
# gate-watch: vendor/grammars.lock.json scripts/vendor/fetch-grammars.ts
# gate-watch: src/services/lsp/webSidecar/** src/services/lsp/sidecarFraming.ts src/services/lsp/serverCatalogue.ts
# gate-watch: src/services/browser/** src/tools/BrowserTool/** src/commands/browser/**
# gate-watch: src/services/visual/** src/services/lsp/builtinServers.ts src/services/lsp/pyrightLane.ts
# gate-watch: scripts/language-sidecars/**
# ============================================================================
#  scripts/language-sidecars/run-all.sh — the native IDE payload.
#
#  Members (globbed — new proofs auto-join):
#    prove-grammar-registry.ts  cpu — the ONE declarative grammar source:
#                               registry integrity, source-package coverage,
#                               dist two-way equality, vendor.json chaining,
#                               routing laws (basename before extension),
#                               and the dead-literal ratchet on build.ts.
#    prove-grammar-census.ts    cpu — the per-grammar SUPPORT BAR against the
#                               real engine: parse + error honesty + the safe
#                               structural-query subset for EVERY registry
#                               row; symbol projection where claimed; named
#                               refusal where not. A grammar that misses its
#                               bar fails the gate — no vanity rows.
# ============================================================================
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# language-sidecars — native IDE payload suite"
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
