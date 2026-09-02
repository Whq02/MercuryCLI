#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/components/mercury-ui/sessionAccent* src/utils/config/**
# gate-watch: src/utils/cockpit/**
# ============================================================================
#  scripts/critters/run-all.sh — the CRITTER-ART integrity gate.
#
#  Joins the one green-gate for free (run-all-suites.sh globs scripts/*/run-all.sh).
#  There is no PNG bake (no drift/regen/escape
#  checks): the mascots are AUTHORED legend grids in critterData.ts, so the
#  checks are:
#    1. HERO-ART integrity — uniform width, legend-only chars, cellColor-mapped,
#       the family invariants (cream eyes + belly band), and the white-dot class
#       locked out (near-white == the deliberate IVORY cream ONLY).
# ============================================================================
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
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

# SMALL-FORM QUALITY (the operator's bar): the silhouette-mirror law
# over the 13w/mini/compact grids, and click-to-cycle at EVERY size through
# the one owner.
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

# The companion voice (the idle-silent bubble + the pool keys) and the
# companion's fit at every berth size.
__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-companion-voice.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-companion-voice.ts "$__t"

__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-companion-fit.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-companion-fit.ts "$__t"

# The mouse-gaze legs (found UNWIRED — a proof that isn't in the
# suite list protects nothing; the §MASCOT-DOWNGRADE berth regression shipped
# past a green gate the same day) + the berth hero-treatment pin.
__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-critter-gaze.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-critter-gaze.ts "$__t"

__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-critter-gaze-live.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-critter-gaze-live.ts "$__t"

# THE LOOK CENSUS: the gaze law — one gaze
# source feeds every eye, offsets clamp inside the aperture, sweeps step
# adjacent — swept per frame over every critter × every animation state,
# plus the two-way stray-highlight band registry (the octopus is uniform).
__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-critter-look-census.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-critter-look-census.ts "$__t"

__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-berth-hero.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-berth-hero.ts "$__t"

# The accent EPOCH: a /critter pick must repaint theme-KEY
# consumers (ThemedBox/ThemedText) — the stale-prompt-box class.
__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-accent-epoch.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-accent-epoch.ts "$__t"

# The accent SNAPSHOT: the same string while nothing changed, a rebuild on
# every store dimension, the same accent object across reads (bare · /accent
# · glow), the unsubscribe law, and zero renders across identical-state
# notifications for a mounted subscriber set.
__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-accent-snapshot.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-accent-snapshot.ts "$__t"

# SLEEP + IDLE FLOW. In the suite from the
# first commit, per the lesson recorded above: a proof that isn't
# in the list protects nothing. Covers the agent-activity sleep derivation and
# its store discipline, the art transforms (pixel-preserving, mass-anchored,
# empty-cells-only), the authored per-critter SLEEP POSES (§7), the packed
# frame key, the geometry contract that keeps a sleeping critter inside the
# awake width budget — and the LIVENESS locks (§8): asleep ⇒ the z
# cycles across sampled frames forever, awake ⇒ the body is in motion,
# wake ⇒ consecutive frames genuinely differ. §8 samples the store-owned
# live key across simulated hours, so the shipped freeze class (epoch stamps
# read against a process-relative clock) goes red if reintroduced.
__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-critter-sleep.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-critter-sleep.ts "$__t"

# THE FRAME CACHE + the effective sway phase: an edge of the clock that
# moves no cell hands React the element it already committed; every frame is
# byte-identical to a cache-less render (hit · miss · fresh def, plain +
# truecolour ANSI); the gaze memos answer the same object per grid.
__t=$SECONDS; if ! "$BUN" run scripts/critters/prove-critter-frame-cache.ts; then
  fail=1
fi
prover_mark scripts/critters/prove-critter-frame-cache.ts "$__t"

# THE GHOST-PIXEL WIPE: a half-block glyph that leaves a cell re-emits the
# neighbour it bled into (above for ▀, below for ▄), byte-identical when no
# glyph leaves — the pure laws through the production writer + the replay
# oracle, then the real bundle: one berth click, the tee replayed through a
# draw-logging screen, the row above the old top run re-emitted.
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
