#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: build.ts src/constants/product* src/prompt/mercuryContract*
# gate-watch: src/prompt/engineIdentity*
# Identity verification gate — one command to prove Mercury's identity is its
# own: the pure bun proofs (no telemetry egress, health self-recognition, the
# distinct model-facing identity, the zero-remnant sweep) + a fresh build + the
# dist string-literal invariants. Run after any change near identity surfaces.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
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
__t=$SECONDS; "$bun" run "$here/prove-native-identity-sweep.ts" || fail=1; prover_mark "$here/prove-native-identity-sweep.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-identity-distinct.ts" || fail=1; prover_mark "$here/prove-identity-distinct.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-no-lineage-vocabulary.ts" || fail=1; prover_mark "$here/prove-no-lineage-vocabulary.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-docs-altitude.ts" || fail=1; prover_mark "$here/prove-docs-altitude.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-provider-neutral-vocabulary.ts" || fail=1; prover_mark "$here/prove-provider-neutral-vocabulary.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-floor-delivery.ts" || fail=1; prover_mark "$here/prove-floor-delivery.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-floor-under-pressure.ts" || fail=1; prover_mark "$here/prove-floor-under-pressure.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-descriptor-divergence.ts" || fail=1; prover_mark "$here/prove-descriptor-divergence.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-literal-footprint.ts" || fail=1; prover_mark "$here/prove-literal-footprint.ts" "$__t"

echo "## build (stamp MACRO, then grep dist)"
if [ "${MERCURY_GATE_PREBUILT:-0}" = "1" ]; then
  # The gate's Phase 0 already built dist from this exact tree (and a mid-pool
  # rebuild would race the suites reading dist). Standalone runs still rebuild.
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
