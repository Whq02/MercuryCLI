#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/run-core/** src/services/run/** src/substrate/** src/services/primitives/**
# gate-watch: src/cli/headless/** src/utils/pulse/** src/utils/sessionStorage/** src/query.ts
# gate-watch: src/utils/sessionRestore.ts src/utils/conversationRecovery.ts src/utils/toolResultSummary.ts src/utils/cockpit/awaySummary.ts
# ============================================================================
#  scripts/run-recovery/run-all.sh — the cross-domain
#  integration lane (the seam-map finding).
#
#  The scenarios with NO truthful home in a domain suite —
#  each crosses two+ owners and asserts them TOGETHER:
#    prove-restart-completed-turn.ts    S16  real dist turn (Write tool) →
#                                            clean exit → --resume relaunch →
#                                            no duplicated message/effect
#    prove-restart-interrupted-turn.ts  S17  SIGKILL the dist mid-stream →
#                                            --resume → honest reconstruction,
#                                            never a fabricated completion
#    prove-hundred-turn-baseline.ts     S28  100 scripted in-process turns
#                                            (text/tool/abort/steer mix) →
#                                            zero accumulated live resources
#                                            across EVERY owner at once
#    prove-late-duplicate-seam.ts       S29  replayed + stale-generation
#                                            events → exactly one effect at
#                                            the kernel/execution/phase/
#                                            durable consumers
#    prove-multiauth-restore.ts         fixture session records spanning
#                                            all three wire dialects (model
#                                            switch · parallel rounds ·
#                                            workflow · compaction) restored
#                                            through the REAL loader chain —
#                                            whole, truthful, family-blind
#
#  gate-class cpu: S16/S17 boot the real dist as HEADLESS children (no PTY,
#  wall-clock-insensitive, dist-boot heavy); the rest are in-process
#  drives. Nothing here belongs in the pty lane. All are hermetic
# no paid calls, no live
#  providers, event/line barriers only (no arbitrary sleeps).
#  Auto-joins the pooled gate via the scripts/*/run-all.sh glob.
# ============================================================================
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# MERCURY run-recovery — cross-domain integration lane"
echo "############################################################"

shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; "$BUN" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done

echo "############################################################"
if [ "$fail" = 0 ]; then echo "# ✅ run-recovery SUITE OK"; else echo "# ❌ run-recovery SUITE FAILED"; fi
echo "############################################################"
exit "$fail"
