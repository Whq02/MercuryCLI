#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/commands.ts src/commands/** src/components/HelpV2/** src/components/mercury-ui/** src/types/command* src/main* src/utils/processUserInput/** README.md
# the beta-surface truth suite: the ONE effective catalogue at the
# command-registry seam (drift + the zero-specimen law, source mode) and the
# generated beta journey matrix against the BUILT artifact (registry truth via
# MERCURY_SURFACE_DUMP + PTY journeys through the rebuilt surfaces).
# capture-model-flash.ts is a SOLO-RUN evidence harness (the L-7 lead), not a
# gate member — run it by hand against a fresh build.
# Auto-joins scripts/run-all-suites.sh (which globs scripts/*/run-all.sh).
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
__t=$SECONDS; "$bun" run "$here/prove-effective-catalogue.ts" || fail=1; prover_mark "$here/prove-effective-catalogue.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-beta-journey-matrix.ts" || fail=1; prover_mark "$here/prove-beta-journey-matrix.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-no-literal-disabled-branches.ts" || fail=1; prover_mark "$here/prove-no-literal-disabled-branches.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-command-privacy.ts" || fail=1; prover_mark "$here/prove-command-privacy.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-readme-roster.ts" || fail=1; prover_mark "$here/prove-readme-roster.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-unavailable-honesty.ts" || fail=1; prover_mark "$here/prove-unavailable-honesty.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-builtins-unshadowable.ts" || fail=1; prover_mark "$here/prove-builtins-unshadowable.ts" "$__t"
exit $fail
