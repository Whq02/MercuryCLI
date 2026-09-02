#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/services/run/** src/services/workbench/** src/services/mission/** src/commands/run/** src/commands/diff/** src/commands/tasks/** src/components/prompts-panel/** src/screens/REPL.tsx
# the frozen J1–J5 golden-journey corpus (M0) against the BUILT
# artifact: seeded real-shape sessions + kernel-folded sidecars + the task
# ledger, walked in a real PTY with grid-composed oracles. Pool mode proves
# harness integrity + journey completion (green in the before AND after
# states); the report-existence sweep below carries the C6 guard (the
# score.ts measurement aggregate left the tree with the scrub wave).
# Auto-joins scripts/run-all-suites.sh (which globs scripts/*/run-all.sh).
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
# Stale-report guard (M6, logic finding C6 — and it bit during this very
# review wave): a journey that dies BEFORE writing its report must not let
# score --check read the previous run's file and call the suite green.
rm -f "${TMPDIR:-/tmp}"/momentum-report-*.json
__t=$SECONDS; "$bun" run "$here/prove-current-work.ts" || fail=1; prover_mark "$here/prove-current-work.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-delivery-artifact.ts" || fail=1; prover_mark "$here/prove-delivery-artifact.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-brief.ts" || fail=1; prover_mark "$here/prove-brief.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-parity.ts" || fail=1; prover_mark "$here/prove-parity.ts" "$__t"
"$bun" run "$here/journey-j1.ts" || fail=1
"$bun" run "$here/journey-j2.ts" || fail=1
"$bun" run "$here/journey-j3.ts" || fail=1
"$bun" run "$here/journey-j4.ts" || fail=1
"$bun" run "$here/journey-j5.ts" || fail=1
# The C6 guard survives score.ts's retirement inline: every journey must have
# written THIS run's report (a journey that dies pre-report can never ride a
# green exit into a green suite).
for j in J1 J2 J3 J4 J5; do
  r="${TMPDIR:-/tmp}/momentum-report-${j}.json"
  if [ ! -s "$r" ]; then
    echo "❌ ${j}: no report written this run (${r})"
    fail=1
  fi
done
exit $fail
