#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: assets/splash/** scripts/ui/vshot.py src/substrate/startupMenu*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
fail=0
echo "############################################################"
echo "# enter-screen splash — proof harness"
echo "############################################################"
__t=$SECONDS; __rc=0; node --check "$here/../../assets/splash/mercury-splash.mjs" || { __rc=$?; fail=1; }; prover_mark "assets/splash/mercury-splash.mjs" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/bake-menu.mjs" --check || { __rc=$?; fail=1; }; prover_mark "$here/bake-menu.mjs" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/bake-ramp.mjs" --check || { __rc=$?; fail=1; }; prover_mark "$here/bake-ramp.mjs" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-face-fit-floor.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-face-fit-floor.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-ramp-parity.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-ramp-parity.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-splash-units.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-splash-units.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-splash-receipt.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-splash-receipt.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-ripple-drain.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-ripple-drain.ts" "$__t" "$__rc"
if [ "$fail" -ne 0 ]; then
  echo "❌ splash suite: FAILURES"
  exit 1
fi
echo "✅ splash suite: ALL GREEN"
