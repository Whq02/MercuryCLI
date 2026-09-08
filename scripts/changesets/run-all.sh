#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/changesets/**
# gate-watch: src/services/changeTransaction/** src/tools/ChangeSetTool/**
# gate-watch: src/components/permissions/ChangeSetPermissionRequest/** src/components/InlineChangeView.tsx
# gate-watch: src/substrate/operationJournal.ts src/substrate/durableOperationMatrix.ts src/substrate/recoveryOrchestrator.ts
# gate-watch: src/tools/LSPTool/mercuryOps.ts src/services/structure/transform.ts src/services/structure/polyglotTransform.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

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
  __t=$SECONDS; __rc=0; if ! { "$bun" "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    echo "RED: $name"
    fail=1
  fi
  prover_mark "$f" "$__t" "$__rc"
done
exit "$fail"
