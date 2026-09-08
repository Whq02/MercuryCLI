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

run scripts/compositor/prove-ground-owner.ts
run scripts/compositor/prove-fill-law.ts
run scripts/compositor/prove-stable-identity.ts
run scripts/compositor/prove-surface-census.ts
run scripts/compositor/prove-hold-takeover.ts
run scripts/compositor/prove-resize-ghost.ts
run scripts/compositor/prove-uiux-wave0-census.ts
run scripts/compositor/prove-ground-contrast-floors.ts
run scripts/compositor/prove-field-findings-keytruth.ts

exit "$fail"
