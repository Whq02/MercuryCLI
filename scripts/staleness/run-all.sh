#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/staleness/**
# gate-watch: src/services/switchboard/harnessGround.ts src/utils/settings/changeDetector.ts
# gate-watch: src/utils/config/projectConfig.ts src/ink/session/windowsHostSetup.ts
# gate-watch: src/utils/router/providerDiscovery.ts src/services/switchboard/capacityCheck.ts
# The staleness suite: the never-stale law — nothing Mercury
# remembers for speed is painted as live truth once the truth has moved.
# Members: the ground-move reset law at the ONE seam (applyHarnessGround),
# the honest-stamp/eviction pins, and the memo registry ratchet (a new
# memoized filesystem/process fact without a named invalidator reds).
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"

failed=0
for prover in scripts/staleness/prove-*.ts; do
  start=$SECONDS
  if ! "$bun" "$prover"; then
    echo "❌ $prover"
    failed=1
  fi
  prover_mark "$prover" "$start"
done

if [ "$failed" -eq 0 ]; then
  echo "staleness: PASS"
else
  echo "staleness: FAIL"
fi
exit "$failed"
