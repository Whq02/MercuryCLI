#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
[ -x "$BUN" ] || BUN="bun"
fail=0
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-no-speculative-catalog.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-no-speculative-catalog.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-model-truth.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-model-truth.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-usage-truth.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-usage-truth.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-submodels.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-submodels.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-submodel-effort-dial.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-submodel-effort-dial.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-model-honesty.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-model-honesty.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-spelling-fold.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-spelling-fold.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-frontier-wire-laws.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-frontier-wire-laws.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-refusal-fallback.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-refusal-fallback.ts "$__t" "$__rc"
exit "$fail"
