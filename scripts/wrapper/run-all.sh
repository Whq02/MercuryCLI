#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/prompt/** src/constants/prompts.ts src/utils/antiSycophancy.ts
# ============================================================================
#  scripts/wrapper/run-all.sh — the Mercury behavioural-contract suite.
#
#  Since the contract is repository-owned source
#  (src/prompt/mercuryContract.ts) — the retired wrapper bridge,
#  its precompiled append, and the freshness digest are retired, so there is
#  no external source to drift from. What this suite still proves:
#
#    - FLOOR PRESENCE (prove-floor-presence.sh): the always-on identity +
#      honesty/safety floor and its assembly seams actually LAND in the built
#      dist — a regression that drops the splice has zero runtime signal.
#    - the anti-sycophancy arm (prove-antisyc-arm.ts): default-OFF flag-gated
#      ship (OFF byte-identical + clause-on).
#
#  The contract laws (repo-owned generation · provider scoping · semantic
#  IDs · one-owner dedup · effort fit) live in scripts/behaviour-laws/.
#
#  Auto-joins the green-gate via scripts/run-all-suites.sh (globs scripts/*/run-all.sh).
# ============================================================================
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Mercury behavioural contract — floor presence + antisyc arm"
echo "############################################################"

# Floor-presence proof (#5) — dist-grep + assembly seams.
__t=$SECONDS; bash "$here/prove-floor-presence.sh"; floor_rc=$?; prover_mark "$here/prove-floor-presence.sh" "$__t"
[ "$floor_rc" != "0" ] && fail=1

# Always-on anti-sycophancy arm — default-OFF flag-gated ship (OFF byte-identical + clause-on).
__t=$SECONDS; "$bun" run "$here/prove-antisyc-arm.ts" || fail=1; prover_mark "$here/prove-antisyc-arm.ts" "$__t"

exit "$fail"
