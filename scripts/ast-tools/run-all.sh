#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/ast-tools/**
# gate-watch: src/utils/astPatterns.ts src/tools/AstSearchTool/** src/tools/AstEditTool/**
# gate-watch: src/services/structure/pattern.ts src/services/structure/polyglotQuery.ts src/services/structure/grammarFacility.ts
set -u
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
