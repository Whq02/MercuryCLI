#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/**
# gate-watch: scripts/lib/*
# gate-watch: src/components/*
# gate-watch: src/services/providers/* src/services/providers/anthropic/*
# gate-watch: src/services/vcr.ts src/services/api/client.ts
# gate-watch: src/services/providers/openai/*
# gate-watch: src/skills/bundled/provider-apis/** mercury-skills/provider-apis/**
# gate-watch: src/cli/headless/*
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
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-token-count-thinking.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-token-count-thinking.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-token-count-thinking-receipt.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-token-count-thinking-receipt.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-count-busy-retry.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-count-busy-retry.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-opus-55-row.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-opus-55-row.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-sonnet-55-row.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-sonnet-55-row.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-haiku-55-row.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-haiku-55-row.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-fable-52-row.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-fable-52-row.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-picker-one-row-per-model.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-picker-one-row-per-model.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-canonical-fold.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-canonical-fold.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-picker-live-rows.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-picker-live-rows.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-family-defaults.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-family-defaults.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-picker-current-mark.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-picker-current-mark.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-picker-anthropic-section.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-picker-anthropic-section.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-picker-composes-without-itself.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-picker-composes-without-itself.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-first-party-windows.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-first-party-windows.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-table-window-above-served.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-table-window-above-served.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-context-1m-header.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-context-1m-header.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-mirror-launch-effort.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-mirror-launch-effort.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-progress-updates-gate.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-progress-updates-gate.ts "$__t" "$__rc"
exit "$fail"
