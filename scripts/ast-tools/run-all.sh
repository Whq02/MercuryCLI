#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/ast-tools/**
# gate-watch: src/utils/astPatterns.ts src/tools/AstSearchTool/** src/tools/AstEditTool/**
# gate-watch: src/services/structure/pattern.ts src/services/structure/polyglotQuery.ts src/services/structure/grammarFacility.ts
# gate-watch: src/Tool.ts src/bootstrap/state.ts src/main.tsx src/services/changeTransaction/receipts.ts
# gate-watch: src/services/structure/grammarRegistry.ts src/services/tools/toolExecution.ts
# gate-watch: src/tools/BashTool/utils.ts src/tools/ChangeSetTool/ChangeSetTool.ts src/utils/*
# gate-watch: src/utils/config/globalConfig.ts src/utils/permissions/filesystem.ts
# gate-watch: src/utils/permissions/permissions.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

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
  __t=$SECONDS; __rc=0; if ! { "$bun" "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    echo "RED: $name"
    fail=1
  fi
  prover_mark "$f" "$__t" "$__rc"
done
exit "$fail"
