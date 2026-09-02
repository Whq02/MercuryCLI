#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/components/mercury-ui/sessionAccent* src/utils/config/**
# gate-watch: src/utils/cockpit/**
set -uo pipefail
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.."
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0

[ -x "$BUN" ] || BUN="bun"

__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-hero-art.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-hero-art.ts "$__t"


__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-critter-persist.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-critter-persist.ts "$__t"

__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-sprite-symmetry.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-sprite-symmetry.ts "$__t"

__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-click-cycle.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-click-cycle.ts "$__t"
__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-persistent-hero.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-persistent-hero.ts "$__t"

__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-companion-voice.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-companion-voice.ts "$__t"

__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-companion-fit.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-companion-fit.ts "$__t"

__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-critter-gaze.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-critter-gaze.ts "$__t"

__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-critter-gaze-live.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-critter-gaze-live.ts "$__t"

__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-critter-look-census.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-critter-look-census.ts "$__t"

__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-berth-hero.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-berth-hero.ts "$__t"

__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-accent-epoch.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-accent-epoch.ts "$__t"

__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-accent-snapshot.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-accent-snapshot.ts "$__t"

__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-critter-sleep.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-critter-sleep.ts "$__t"

__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-critter-frame-cache.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-critter-frame-cache.ts "$__t"

__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-ghost-wipe.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-ghost-wipe.ts "$__t"

__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-ghost-wipe-live.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-ghost-wipe-live.ts "$__t"

__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-square-berths.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-square-berths.ts "$__t"

[ "$fail" -eq 0 ] && echo "✅ critters — hero-art integrity + persistent-hero + gaze + berth-hero + accent-epoch + sleep/flow contracts hold"
exit "$fail"
