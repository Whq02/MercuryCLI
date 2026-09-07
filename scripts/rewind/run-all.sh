#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/rewind/**
# gate-watch: src/utils/fileHistory.ts src/services/compact/checkpointRewind.ts src/cli/headless/controlHandlers.ts
# gate-watch: src/daemon/protocol.ts src/daemon/sessionSeat.ts src/daemon/controlServer.ts src/daemon/controlSocket.ts
# gate-watch: src/components/MessageSelector.tsx src/services/engine-connector/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Mercury /rewind — proof harness"
echo "############################################################"
__t=$SECONDS; "$bun" run "$here/prove-rewind-capture.ts" || fail=1; prover_mark "$here/prove-rewind-capture.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-rewind-wire.ts" || fail=1; prover_mark "$here/prove-rewind-wire.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-rewind-restore.ts" || fail=1; prover_mark "$here/prove-rewind-restore.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-rewind-cockpit.ts" || fail=1; prover_mark "$here/prove-rewind-cockpit.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-checkpoint-sweep-economy.ts" || fail=1; prover_mark "$here/prove-checkpoint-sweep-economy.ts" "$__t"

echo
if [ "$fail" -eq 0 ]; then
  echo "✅ REWIND SUITE: ALL PASS"
else
  echo "❌ REWIND SUITE: FAILURES"
fi
exit "$fail"
