#!/usr/bin/env bash
# gate-class: pty
# (this suite drives the BUILT dist through vshot (real PTY product boots); the class annotation lives on this line: the gate registry parses the header line as the bare class)
# gate-watch: scripts/pings/**
# gate-watch: src/services/pings/** src/hooks/usePingEngine.ts src/services/attention/**
# gate-watch: src/components/MercuryFrame.tsx src/services/engine-connector/daemonConnector.ts
# gate-watch: src/commands/pings/** src/components/messages/SystemTextMessage.tsx
# ============================================================================
#  scripts/pings/run-all.sh — the PINGS estate: the tap engine (one ring per
#  new need, re-ring never, coalesced, seed-silent, quiet by choice), the
#  strip badge, the model-switched note, and the /pings toggle.
#
#  Auto-joins scripts/run-all-suites.sh via its scripts/*/run-all.sh glob.
# ============================================================================
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# pings — a session taps you when it needs you"
echo "############################################################"

for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; (cd "$repo" && "$bun" run "$proof") || fail=1; prover_mark "$proof" "$__t"
done

# The MACHINE-GATED lane: a journey-*.ts may exit 3 to mean "this machine
# cannot run the journey — the gate is honoured, loudly". 0 = ran and
# passed; anything else is a real failure.
for journey in "$here"/journey-*.ts; do
  [ -e "$journey" ] || continue
  echo
  echo "── $(basename "$journey") (machine-gated) ──"
  __t=$SECONDS
  (cd "$repo" && "$bun" run "$journey")
  got=$?
  prover_mark "$journey" "$__t"
  if [ "$got" = "3" ]; then
    echo "⏭  $(basename "$journey") SKIP — machine gate honoured"
  elif [ "$got" != "0" ]; then
    echo "❌ $(basename "$journey") exited $got (0 = pass, 3 = machine-gate SKIP)"
    fail=1
  fi
done

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ pings PASS"; else echo "# ❌ pings FAILED"; fi
echo "############################################################"
exit "$fail"
