#!/bin/bash
# gate-class: pty
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1

BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0

run() {
  echo "── $1"
  local __t=$SECONDS __rc=0
  if ! { "$BUN" run "$1"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    fail=1
  fi
  prover_mark "$1" "$__t" "$__rc"
}

run scripts/render-engine/prove-ledger-law.ts
run scripts/render-engine/prove-projection-flat.ts
run scripts/render-engine/prove-doubles-seed.ts
run scripts/render-engine/prove-door-law.ts
run scripts/render-engine/prove-sync-bracket.ts
run scripts/render-engine/prove-scheduler-cost.ts
run scripts/render-engine/prove-backpressure.ts
run scripts/render-engine/prove-resize-settle.ts
run scripts/render-engine/prove-overlay-law.ts
run scripts/render-engine/prove-tail-bound.ts
run scripts/render-engine/prove-time-flat.ts
run scripts/render-engine/prove-settle-no-sync-flush.ts
run scripts/render-engine/prove-stable-prefix.ts
run scripts/render-engine/prove-flag-dormant.ts
run scripts/render-engine/prove-junk-smoke.ts

if [ "$fail" -ne 0 ]; then
  echo "render-engine: RED"
  exit 1
fi
echo "render-engine: GREEN"
