#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/changesets/**
# gate-watch: src/services/changeTransaction/** src/tools/ChangeSetTool/**
# gate-watch: src/components/permissions/ChangeSetPermissionRequest/** src/components/InlineChangeView.tsx
# gate-watch: src/substrate/operationJournal.ts src/substrate/durableOperationMatrix.ts src/substrate/recoveryOrchestrator.ts
# gate-watch: src/tools/LSPTool/mercuryOps.ts src/services/structure/transform.ts src/services/structure/polyglotTransform.ts
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# MERCURY changesets — atomic multi-file text change sets"
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
