#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/**
# ============================================================================
#  scripts/model-registry/run-all.sh — the MODEL-CATALOG wiring gate.
#  Joins the one green-gate for free (run-all-suites.sh globs scripts/*/run-all.sh).
#  Proves every LIVE future-model-catalog entry resolves through every capability
#  consumer (thinking · betas · 1M · picker toggle · context · output · cost ·
#  effort) — the anti-rot check for the seam whose whole point is "one entry, every
#  consumer reads it", and which shipped three silent misses before it existed.
# ============================================================================
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
[ -x "$BUN" ] || BUN="bun"
fail=0
__t=$SECONDS; "$BUN" run scripts/model-registry/prove-no-speculative-catalog.ts || fail=1; prover_mark scripts/model-registry/prove-no-speculative-catalog.ts "$__t"
# MODEL-TRUTH ratchet: stale display copy +
# era-relative role pins alarm here instead of silently aging past a launch.
__t=$SECONDS; "$BUN" run scripts/model-registry/prove-model-truth.ts || fail=1; prover_mark scripts/model-registry/prove-model-truth.ts "$__t"
# USAGE-TRUTH: one live usage owner, two
# renderers, honest shapes — mechanisms pinned, never numbers.
__t=$SECONDS; "$BUN" run scripts/model-registry/prove-usage-truth.ts || fail=1; prover_mark scripts/model-registry/prove-usage-truth.ts "$__t"
# SUB-MODEL containers (Minerva · Console): derivation from the registry,
# signed-out routing, the persistence ladder, the serve/refusal grammar.
__t=$SECONDS; "$BUN" run scripts/model-registry/prove-submodels.ts || fail=1; prover_mark scripts/model-registry/prove-submodels.ts "$__t"
__t=$SECONDS; "$BUN" run scripts/model-registry/prove-model-honesty.ts || fail=1; prover_mark scripts/model-registry/prove-model-honesty.ts "$__t"
# SPELLING FOLD (AGENTDIALS C2): human spellings resolve against the
# catalogue's ids AND display names at the ONE normalizer — derived,
# provider-equal, gated on the already-refused class; driven at the
# coordinator door.
__t=$SECONDS; "$BUN" run scripts/model-registry/prove-spelling-fold.ts || fail=1; prover_mark scripts/model-registry/prove-spelling-fold.ts "$__t"
# FRONTIER WIRE LAWS (Claude Fable 5.1): forced tool_choice folds to auto
# where the model rejects it; thinking is always on for the family — both
# Anthropic wire builders ride the one owner.
__t=$SECONDS; "$BUN" run scripts/model-registry/prove-frontier-wire-laws.ts || fail=1; prover_mark scripts/model-registry/prove-frontier-wire-laws.ts "$__t"
# REFUSAL FALLBACK (MERCURY_REFUSAL_FALLBACK, opt-in): the one request owner,
# the models it arms, the byline and the served-model wiring — never silent.
__t=$SECONDS; "$BUN" run scripts/model-registry/prove-refusal-fallback.ts || fail=1; prover_mark scripts/model-registry/prove-refusal-fallback.ts "$__t"
exit "$fail"
