#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/tools/EnterPlanModeTool/prompt* src/tools/ExitPlanModeTool/prompt*
# gate-watch: src/types/permissions* src/utils/autopilot/** src/utils/effort*
# gate-watch: src/utils/model/model* src/utils/permissions/PermissionMode*
# gate-watch: src/utils/permissions/getNextPermissionMode*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# autopilot — mode machinery · SetTier rails · plan doctrine"
echo "############################################################"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-carousel-autopilot.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-carousel-autopilot.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-settier.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-settier.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-plan-doctrine.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-plan-doctrine.ts" "$__t" "$__rc"
if [ "$fail" -ne 0 ]; then
  echo "autopilot suite: RED"
  exit 1
fi
echo "autopilot suite: green"
