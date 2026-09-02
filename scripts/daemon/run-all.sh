#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/daemon/** src/substrate/flagRegistry* src/types/permissions*
# Mercury daemon — proof harness. Non-zero exit on any fail.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Mercury daemon — proof harness"
echo "############################################################"
__t=$SECONDS; "$bun" run "$here/prove-pty-degrade.ts" || fail=1; prover_mark "$here/prove-pty-degrade.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-supervisor-lock.ts" || fail=1; prover_mark "$here/prove-supervisor-lock.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-daemon-verbs.ts" || fail=1; prover_mark "$here/prove-daemon-verbs.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-dispatch-death-settles.ts" || fail=1; prover_mark "$here/prove-dispatch-death-settles.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-daemon-env-scrub.ts" || fail=1; prover_mark "$here/prove-daemon-env-scrub.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-reconfigure-respawn.ts" || fail=1; prover_mark "$here/prove-reconfigure-respawn.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-headless-permission-mode.ts" || fail=1; prover_mark "$here/prove-headless-permission-mode.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-daemon-dir-seam.ts" || fail=1; prover_mark "$here/prove-daemon-dir-seam.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-worker-census.ts" || fail=1; prover_mark "$here/prove-worker-census.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-halt-roster.ts" || fail=1; prover_mark "$here/prove-halt-roster.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-worker-recon.ts" || fail=1; prover_mark "$here/prove-worker-recon.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-warm-runner.ts" || fail=1; prover_mark "$here/prove-warm-runner.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-newborn-grace.ts" || fail=1; prover_mark "$here/prove-newborn-grace.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-kit-birth.ts" || fail=1; prover_mark "$here/prove-kit-birth.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-parked-state.ts" || fail=1; prover_mark "$here/prove-parked-state.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-reactivate-door.ts" || fail=1; prover_mark "$here/prove-reactivate-door.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-close-all.ts" || fail=1; prover_mark "$here/prove-close-all.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-status-honesty.ts" || fail=1; prover_mark "$here/prove-status-honesty.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-focus-one-writer.ts" || fail=1; prover_mark "$here/prove-focus-one-writer.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-protocol-shape.ts" || fail=1; prover_mark "$here/prove-protocol-shape.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-compact-state-word.ts" || fail=1; prover_mark "$here/prove-compact-state-word.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-daemon-handshake.ts" || fail=1; prover_mark "$here/prove-daemon-handshake.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-send-hops.ts" || fail=1; prover_mark "$here/prove-send-hops.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-rename-migration.ts" || fail=1; prover_mark "$here/prove-rename-migration.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-saturn-core.ts" || fail=1; prover_mark "$here/prove-saturn-core.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-saturn-adversarial.ts" || fail=1; prover_mark "$here/prove-saturn-adversarial.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-saturn-keyless.ts" || fail=1; prover_mark "$here/prove-saturn-keyless.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-leak-sweep.ts" || fail=1; prover_mark "$here/prove-leak-sweep.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-loop-cadence.ts" || fail=1; prover_mark "$here/prove-loop-cadence.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-live-turn-chars.ts" || fail=1; prover_mark "$here/prove-live-turn-chars.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-liveness-stamp.ts" || fail=1; prover_mark "$here/prove-liveness-stamp.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-seat-line-adversarial.ts" || fail=1; prover_mark "$here/prove-seat-line-adversarial.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-worker-liveness-identity.ts" || fail=1; prover_mark "$here/prove-worker-liveness-identity.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-quit-reaps-the-tree.ts" || fail=1; prover_mark "$here/prove-quit-reaps-the-tree.ts" "$__t"
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL DAEMON PROOFS PASS"; else echo "# ❌ SOME DAEMON PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
