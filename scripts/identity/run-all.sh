#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: build.ts src/constants/product* src/prompt/mercuryContract*
# gate-watch: src/prompt/engineIdentity*
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../.."
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Identity verification gate"
echo "############################################################"

echo "## bun proofs (pure gate logic)"
__t=$SECONDS; "$bun" run "$root/scripts/substrate/prove-health-self-recognition.ts" || fail=1; prover_mark "$root/scripts/substrate/prove-health-self-recognition.ts" "$__t"
__t=$SECONDS; "$bun" run "$root/scripts/substrate/prove-no-telemetry-egress.ts" || fail=1; prover_mark "$root/scripts/substrate/prove-no-telemetry-egress.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-docs-altitude.ts" || fail=1; prover_mark "$here/prove-docs-altitude.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-release-notes-words.ts" || fail=1; prover_mark "$here/prove-release-notes-words.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-provider-neutral-vocabulary.ts" || fail=1; prover_mark "$here/prove-provider-neutral-vocabulary.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-floor-delivery.ts" || fail=1; prover_mark "$here/prove-floor-delivery.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-floor-under-pressure.ts" || fail=1; prover_mark "$here/prove-floor-under-pressure.ts" "$__t"

echo "## build (stamp MACRO, then grep dist)"
if [ "${MERCURY_GATE_PREBUILT:-0}" = "1" ]; then
  echo "  ✓ build OK (gate-prebuilt)"
else
  "$bun" run "$root/build.ts" >/dev/null 2>&1 && echo "  ✓ build OK" || { echo "  ✗ build FAILED"; fail=1; }
fi

echo "## dist invariants"
__t=$SECONDS; bash "$here/prove-dist-invariants.sh" || fail=1; prover_mark "$here/prove-dist-invariants.sh" "$__t"

echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL IDENTITY CHECKS PASS"; else echo "# ❌ IDENTITY CHECKS FAILED"; fi
echo "############################################################"
exit "$fail"
