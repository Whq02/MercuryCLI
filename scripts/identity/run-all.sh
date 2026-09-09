#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: build.ts src/constants/product* src/prompt/mercuryContract*
# gate-watch: src/prompt/engineIdentity* package.json
# gate-watch: docs/** *.md **/*.md .github/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../.."
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Identity suite"
echo "############################################################"

echo "## build (the bundle-facing rules read dist)"
if [ "${MERCURY_GATE_PREBUILT:-0}" = "1" ]; then
  echo "  ✓ build OK (gate-prebuilt)"
else
  "$bun" run "$root/build.ts" >/dev/null 2>&1 && echo "  ✓ build OK" || { echo "  ✗ build FAILED"; fail=1; }
fi

echo "## bun proofs"
__t=$SECONDS; __rc=0; "$bun" run "$root/scripts/substrate/prove-health-self-recognition.ts" || { __rc=$?; fail=1; }; prover_mark "$root/scripts/substrate/prove-health-self-recognition.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$root/scripts/substrate/prove-no-telemetry-egress.ts" || { __rc=$?; fail=1; }; prover_mark "$root/scripts/substrate/prove-no-telemetry-egress.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-vocabulary.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-vocabulary.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-tree-hygiene.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-tree-hygiene.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-docs-altitude.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-docs-altitude.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-release-notes-words.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-release-notes-words.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-provider-neutral-vocabulary.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-provider-neutral-vocabulary.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-floor-delivery.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-floor-delivery.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-floor-under-pressure.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-floor-under-pressure.ts" "$__t" "$__rc"

echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL IDENTITY CHECKS PASS"; else echo "# ❌ IDENTITY CHECKS FAILED"; fi
echo "############################################################"
exit "$fail"
