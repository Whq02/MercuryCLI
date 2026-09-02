#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: assets/splash/** scripts/ui/vshot.py src/substrate/startupMenu*
# Enter-screen splash — proof harness (API-free; the visual check is
# capture.sh → PNG, the byte contract is prove-splash.py in a real pty).
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
fail=0
echo "############################################################"
echo "# enter-screen splash — proof harness"
echo "############################################################"
node --check "$here/../../assets/splash/mercury-splash.mjs" || fail=1
"${BUN:-$HOME/.bun/bin/bun}" run "$here/bake-menu.mjs" --check || fail=1
"${BUN:-$HOME/.bun/bin/bun}" run "$here/bake-ramp.mjs" --check || fail=1
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-face-fit-floor.ts" || fail=1; prover_mark "$here/prove-face-fit-floor.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-ramp-parity.ts" || fail=1; prover_mark "$here/prove-ramp-parity.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-splash-units.ts" || fail=1; prover_mark "$here/prove-splash-units.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-splash-receipt.ts" || fail=1; prover_mark "$here/prove-splash-receipt.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-ripple-drain.ts" || fail=1; prover_mark "$here/prove-ripple-drain.ts" "$__t"
__t=$SECONDS; /usr/bin/python3 "$here/prove-splash.py" || fail=1; prover_mark "$here/prove-splash.py" "$__t"
if [ "$fail" -ne 0 ]; then
  echo "❌ splash suite: FAILURES"
  exit 1
fi
echo "✅ splash suite: ALL GREEN"
