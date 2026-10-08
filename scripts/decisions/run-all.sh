#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/Tool* src/utils/errors/** src/utils/permissions/decision/**
# gate-watch: src/utils/permissions/permissions*
# gate-watch: src/tools/BashTool/* src/tools/PowerShellTool/* src/utils/errors.ts
# gate-watch: src/utils/permissions/shellRuleMatching.ts src/utils/bash/parser.ts src/utils/bash/ast.ts src/utils/bash/bashParser.ts src/utils/bash/commands.ts src/utils/bash/ParsedCommand.ts src/utils/bash/treeSitterAnalysis.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# decisions — permission decision-chain proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
exit $fail
