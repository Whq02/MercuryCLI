#!/bin/bash
# gate-class: pty
set -uo pipefail
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.."

BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0

run() {
  echo "── $*"
  local __t=$SECONDS
  if ! "$BUN" run "$@"; then
    fail=1
  fi
  prover_mark "$1" "$__t"
}

echo "── bun run build.ts (the stale-dist guard: one build, every pty prover below runs against it)"
__b=$SECONDS
if ! "$BUN" run build.ts > /dev/null 2>&1; then
  echo "render-migration: build failed"
  exit 1
fi
printf '── build.ts  %ss\n' "$(( SECONDS - __b ))"

run scripts/render-migration/prove-record-fold.ts
run scripts/render-migration/prove-cockpit-ledger.ts
run scripts/render-migration/prove-scheduler-gates.ts
run scripts/render-migration/prove-door-fold.ts
run scripts/render-migration/prove-doubles-growth-curve.ts --turns 18
run scripts/render-migration/prove-engine-cockpit-smoke.ts --skip-build
run scripts/render-migration/prove-look-parity.ts --skip-build

if [ "$fail" -ne 0 ]; then
  echo "render-migration: RED"
  exit 1
fi
echo "render-migration: GREEN"
