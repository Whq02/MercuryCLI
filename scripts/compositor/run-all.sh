#!/bin/bash
# gate-class: pty
# ============================================================================
#  scripts/compositor/run-all.sh — terminal compositor +
#  interaction continuity.
#
#  S1 — one explicit canvas model: the ONE terminal-ground lifecycle owner
#       (oasisBg.ts; warmBackground.ts is a facade); exactly-once restore.
#  S2 — full-screen takeover is a transaction: launcher hold → picker →
#       cockpit stays inside one owned alt-screen session, erase folded
#       atomically into the first frame (built-binary PTY + cell grid).
# ============================================================================
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
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
