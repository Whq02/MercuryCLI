#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/prompt/** src/constants/prompts.ts src/utils/antiSycophancy.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Mercury behavioural contract — floor presence + antisyc arm"
echo "############################################################"

__t=$SECONDS; bash "$here/prove-floor-presence.sh"; floor_rc=$?; prover_mark "$here/prove-floor-presence.sh" "$__t"
[ "$floor_rc" != "0" ] && fail=1

__t=$SECONDS; "$bun" run "$here/prove-antisyc-arm.ts" || fail=1; prover_mark "$here/prove-antisyc-arm.ts" "$__t"

exit "$fail"
