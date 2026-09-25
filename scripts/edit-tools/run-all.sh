#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/edit-tools/fixtures/**
# gate-watch: src/tools/FileReadTool/** src/tools/FileEditTool/** src/tools/FileWriteTool/**
# gate-watch: src/services/changeTransaction/** src/services/ide/** src/services/resources/**
# gate-watch: src/services/repoHost/** src/tools/GitTool/** src/tools/TestTool/** src/tools/LaunchTool/** src/utils/healthReport.ts
# gate-watch: scripts/daemon/dupline-world.ts scripts/lib/scriptedTurn.ts src/Tool.ts
# gate-watch: src/native-ts/color-diff/index.ts src/services/gitGraph/observe.ts
# gate-watch: src/services/providers/callModelRouter.ts src/services/run/* src/services/tools/toolExecution.ts
# gate-watch: src/substrate/flagRegistry.ts src/substrate/operationJournal.ts src/tools.ts
# gate-watch: src/tools/ChangeSetTool/ChangeSetTool.ts src/tools/GrepTool/GrepTool.ts
# gate-watch: src/tools/ToolSearchTool/ToolSearchTool.ts src/utils/* src/utils/config/globalConfig.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

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
  __t=$SECONDS; __rc=0; if ! { "$bun" "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    echo "RED: $name"
    fail=1
  fi
  prover_mark "$f" "$__t" "$__rc"
done
exit "$fail"
