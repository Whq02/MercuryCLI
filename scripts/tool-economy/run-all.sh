#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/tools/TestTool/* src/tools/BashTool/* src/services/ide/projectRunners.ts
# gate-watch: src/tools/ToolSearchTool/** src/utils/model/capabilities*
# gate-watch: src/types/message.ts src/utils/attachments/types.ts
# gate-watch: src/run-core/turn/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# tool-economy — prefix instrument · route-independent deferral laws"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/measure-*.ts "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
exit "$fail"
