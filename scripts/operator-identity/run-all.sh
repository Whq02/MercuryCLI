#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/** scripts/operator-identity/**
# Mercury operator identity — the extraction's boundary ratchet and (as the
# hardening lands) the operator key's pins: birth · id derivation · the
# one-shot migration · account facts · signing. The broad watch is the
# ratchet's subject: ANY new src import can cross the estate boundary.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Mercury operator identity — boundary + hardening"
echo "############################################################"
__t=$SECONDS; "$bun" run "$here/prove-estate-boundary.ts" || fail=1; prover_mark "$here/prove-estate-boundary.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-operator-identity.ts" || fail=1; prover_mark "$here/prove-operator-identity.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-identity-migration.ts" || fail=1; prover_mark "$here/prove-identity-migration.ts" "$__t"

if [ "$fail" -ne 0 ]; then
  echo "❌ operator-identity suite RED"
  exit 1
fi
echo "✅ operator-identity suite green"
