#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/components/mercury-ui/sessionAccent* src/utils/config/**
# gate-watch: src/utils/cockpit/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0

[ -x "$BUN" ] || BUN="bun"

__t=$SECONDS; __rc=0; if ! { "$BUN" run scripts/critters/prove-hero-art.ts; __rc=$?; [ "$__rc" -eq 0 ]; }; then
  fail=1
fi
prover_mark scripts/critters/prove-hero-art.ts "$__t" "$__rc"


__t=$SECONDS; __rc=0; if ! { "$BUN" run scripts/critters/prove-critter-persist.ts; __rc=$?; [ "$__rc" -eq 0 ]; }; then
  fail=1
fi
prover_mark scripts/critters/prove-critter-persist.ts "$__t" "$__rc"

__t=$SECONDS; __rc=0; if ! { "$BUN" run scripts/critters/prove-sprite-symmetry.ts; __rc=$?; [ "$__rc" -eq 0 ]; }; then
  fail=1
fi
prover_mark scripts/critters/prove-sprite-symmetry.ts "$__t" "$__rc"

__t=$SECONDS; __rc=0; if ! { "$BUN" run scripts/critters/prove-click-cycle.ts; __rc=$?; [ "$__rc" -eq 0 ]; }; then
  fail=1
fi
prover_mark scripts/critters/prove-click-cycle.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; if ! { "$BUN" run scripts/critters/prove-persistent-hero.ts; __rc=$?; [ "$__rc" -eq 0 ]; }; then
  fail=1
fi
prover_mark scripts/critters/prove-persistent-hero.ts "$__t" "$__rc"

__t=$SECONDS; __rc=0; if ! { "$BUN" run scripts/critters/prove-companion-voice.ts; __rc=$?; [ "$__rc" -eq 0 ]; }; then
  fail=1
fi
prover_mark scripts/critters/prove-companion-voice.ts "$__t" "$__rc"

__t=$SECONDS; __rc=0; if ! { "$BUN" run scripts/critters/prove-companion-fit.ts; __rc=$?; [ "$__rc" -eq 0 ]; }; then
  fail=1
fi
prover_mark scripts/critters/prove-companion-fit.ts "$__t" "$__rc"

__t=$SECONDS; __rc=0; if ! { "$BUN" run scripts/critters/prove-critter-gaze.ts; __rc=$?; [ "$__rc" -eq 0 ]; }; then
  fail=1
fi
prover_mark scripts/critters/prove-critter-gaze.ts "$__t" "$__rc"

__t=$SECONDS; __rc=0; if ! { "$BUN" run scripts/critters/prove-critter-look-census.ts; __rc=$?; [ "$__rc" -eq 0 ]; }; then
  fail=1
fi
prover_mark scripts/critters/prove-critter-look-census.ts "$__t" "$__rc"

__t=$SECONDS; __rc=0; if ! { "$BUN" run scripts/critters/prove-accent-epoch.ts; __rc=$?; [ "$__rc" -eq 0 ]; }; then
  fail=1
fi
prover_mark scripts/critters/prove-accent-epoch.ts "$__t" "$__rc"

__t=$SECONDS; __rc=0; if ! { "$BUN" run scripts/critters/prove-accent-snapshot.ts; __rc=$?; [ "$__rc" -eq 0 ]; }; then
  fail=1
fi
prover_mark scripts/critters/prove-accent-snapshot.ts "$__t" "$__rc"

__t=$SECONDS; __rc=0; if ! { "$BUN" run scripts/critters/prove-critter-sleep.ts; __rc=$?; [ "$__rc" -eq 0 ]; }; then
  fail=1
fi
prover_mark scripts/critters/prove-critter-sleep.ts "$__t" "$__rc"

__t=$SECONDS; __rc=0; if ! { "$BUN" run scripts/critters/prove-critter-frame-cache.ts; __rc=$?; [ "$__rc" -eq 0 ]; }; then
  fail=1
fi
prover_mark scripts/critters/prove-critter-frame-cache.ts "$__t" "$__rc"

__t=$SECONDS; __rc=0; if ! { "$BUN" run scripts/critters/prove-ghost-wipe.ts; __rc=$?; [ "$__rc" -eq 0 ]; }; then
  fail=1
fi
prover_mark scripts/critters/prove-ghost-wipe.ts "$__t" "$__rc"

__t=$SECONDS; __rc=0; if ! { "$BUN" run scripts/critters/prove-square-berths.ts; __rc=$?; [ "$__rc" -eq 0 ]; }; then
  fail=1
fi
prover_mark scripts/critters/prove-square-berths.ts "$__t" "$__rc"

[ "$fail" -eq 0 ] && echo "✅ critters — hero-art integrity + persistent-hero + gaze + accent-epoch + sleep/flow contracts hold"
exit "$fail"
