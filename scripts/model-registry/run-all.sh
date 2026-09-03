#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/**
set -uo pipefail
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
[ -x "$BUN" ] || BUN="bun"
fail=0
__t=$SECONDS; "$BUN" run scripts/model-registry/prove-no-speculative-catalog.ts || fail=1; prover_mark scripts/model-registry/prove-no-speculative-catalog.ts "$__t"
__t=$SECONDS; "$BUN" run scripts/model-registry/prove-model-truth.ts || fail=1; prover_mark scripts/model-registry/prove-model-truth.ts "$__t"
__t=$SECONDS; "$BUN" run scripts/model-registry/prove-usage-truth.ts || fail=1; prover_mark scripts/model-registry/prove-usage-truth.ts "$__t"
__t=$SECONDS; "$BUN" run scripts/model-registry/prove-submodels.ts || fail=1; prover_mark scripts/model-registry/prove-submodels.ts "$__t"
__t=$SECONDS; "$BUN" run scripts/model-registry/prove-submodel-effort-dial.ts || fail=1; prover_mark scripts/model-registry/prove-submodel-effort-dial.ts "$__t"
__t=$SECONDS; "$BUN" run scripts/model-registry/prove-model-honesty.ts || fail=1; prover_mark scripts/model-registry/prove-model-honesty.ts "$__t"
__t=$SECONDS; "$BUN" run scripts/model-registry/prove-spelling-fold.ts || fail=1; prover_mark scripts/model-registry/prove-spelling-fold.ts "$__t"
__t=$SECONDS; "$BUN" run scripts/model-registry/prove-frontier-wire-laws.ts || fail=1; prover_mark scripts/model-registry/prove-frontier-wire-laws.ts "$__t"
__t=$SECONDS; "$BUN" run scripts/model-registry/prove-refusal-fallback.ts || fail=1; prover_mark scripts/model-registry/prove-refusal-fallback.ts "$__t"
exit "$fail"
