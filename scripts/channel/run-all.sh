#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/channel/** src/substrate/identity/**
# Mercury channel — the connection primitive (sealed link · frame envelope ·
# hybrid clock · frame signing), extracted from the multiplayer estate. The
# estate's own suites keep the room/transport journeys; THIS suite owns the
# primitive's invariants so they survive the estate's retirement.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Mercury channel — the connection primitive"
echo "############################################################"
__t=$SECONDS; "$bun" run "$here/prove-channel-primitives.ts" || fail=1; prover_mark "$here/prove-channel-primitives.ts" "$__t"

if [ "$fail" -ne 0 ]; then
  echo "❌ channel suite RED"
  exit 1
fi
echo "✅ channel suite green"
