#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/QueryEngine* src/screens/REPL* src/utils/hooks/commitGate*
# gate-watch: src/utils/verification/verificationState*
# gate-watch: src/utils/hooks/generatedAssets* scripts/gate/generated-assets.tsv scripts/gate/generated-assets.ts
# gate-watch: assets/completions/mercury.bash assets/splash/splash-core.mjs
# gate-watch: assets/vulcan/addon/core/op_classes.gd scripts/builtin-tools/bench-builtin-tools.ts
# gate-watch: scripts/builtin-tools/fixtures/RESULTS.md scripts/consistency-census/*
# gate-watch: scripts/critters/fixtures/zzz-frames.json scripts/critters/gen-zzz-frames.ts
# gate-watch: scripts/ink-runtime/deep-import-inventory.json scripts/lib/generated-assets-map.mjs
# gate-watch: scripts/lib/hermetic.ts scripts/splash/bake-menu.mjs scripts/vulcan/regen-optable.mjs
# gate-watch: src/components/Message.tsx src/main.tsx src/utils/vulcan/optable.generated.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# &&-commit-gate — proof harness"
echo "############################################################"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-commit-gate-wiring.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-commit-gate-wiring.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-commit-gate.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-commit-gate.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-generated-assets.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-generated-assets.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; bash "$here/prove-shell.sh" || { __rc=$?; fail=1; }; prover_mark "$here/prove-shell.sh" "$__t" "$__rc"
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL PROOFS PASS"; else echo "# ❌ SOME PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
