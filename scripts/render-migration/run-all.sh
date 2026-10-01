#!/bin/bash
# gate-class: pty
# gate-watch: scripts/lib/captureDriver.ts scripts/lib/spawnCapture.ts scripts/lib/firstRunSeed.ts scripts/ui/visualBaseline.ts
# gate-watch: scripts/ui/vshot.py src/bootstrap/state.ts src/components/messages/nullRenderingAttachments.ts
# gate-watch: src/ink/root/render-scheduler.ts src/ink/session/delivery.ts src/query.ts src/query/deps.ts
# gate-watch: src/render-engine/cockpit/* src/run-core/project-legacy.ts src/state/AppStateStore.ts
# gate-watch: src/utils/* src/utils/cockpit/turnReceipt.ts src/utils/config/globalConfig.ts
# gate-watch: src/utils/messages/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1

BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0

run() {
  echo "── $*"
  local __t=$SECONDS __rc=0
  if ! { "$BUN" run "$@"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    fail=1
  fi
  prover_mark "$1" "$__t" "$__rc"
}

if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'render-migration: dist/mercury.mjs absent; run bun run build.ts before the suite'
  exit 1
fi

run scripts/render-migration/prove-record-fold.ts
run scripts/render-migration/prove-cockpit-ledger.ts
run scripts/render-migration/prove-scheduler-gates.ts
run scripts/render-migration/prove-door-fold.ts
run scripts/render-migration/prove-doubles-growth-curve.ts --turns 18
run scripts/render-migration/prove-engine-cockpit-smoke.ts
run scripts/render-migration/prove-look-parity.ts

if [ "$fail" -ne 0 ]; then
  echo "render-migration: RED"
  exit 1
fi
echo "render-migration: GREEN"
