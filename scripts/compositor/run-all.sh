#!/bin/bash
# gate-class: pty
set -uo pipefail
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.."

BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0

run() {
  echo "── $1"
  local __t=$SECONDS
  if ! "$BUN" run "$1"; then
    fail=1
  fi
  prover_mark "$1" "$__t"
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
