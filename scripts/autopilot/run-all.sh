#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/tools/EnterPlanModeTool/prompt* src/tools/ExitPlanModeTool/prompt*
# gate-watch: src/types/permissions* src/utils/autopilot/** src/utils/effort*
# gate-watch: src/utils/model/model* src/utils/permissions/PermissionMode*
# gate-watch: src/utils/permissions/getNextPermissionMode*
# autopilot — the self-serve tier mode proof suite. Non-zero exit on any fail.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# autopilot — mode machinery · SetTier rails · plan doctrine"
echo "############################################################"
__t=$SECONDS; "$bun" run "$here/prove-carousel-autopilot.ts" || fail=1; prover_mark "$here/prove-carousel-autopilot.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-settier.ts" || fail=1; prover_mark "$here/prove-settier.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-plan-doctrine.ts" || fail=1; prover_mark "$here/prove-plan-doctrine.ts" "$__t"
if [ "$fail" -ne 0 ]; then
  echo "autopilot suite: RED"
  exit 1
fi
echo "autopilot suite: green"
