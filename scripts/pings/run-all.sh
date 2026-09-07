#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/pings/**
# gate-watch: src/services/pings/** src/hooks/usePingEngine.ts src/services/attention/**
# gate-watch: src/components/MercuryFrame.tsx src/services/engine-connector/daemonConnector.ts
# gate-watch: src/commands/pings/** src/components/messages/SystemTextMessage.tsx
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
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
