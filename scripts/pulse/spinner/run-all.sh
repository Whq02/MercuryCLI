#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/../../lib/proof-runner.sh"
cd "$(dirname "$0")/../../.."
BUN="${BUN:-$HOME/.bun/bin/bun}"

fail=0
run_proof scripts/pulse/spinner/prove-stall-honesty.ts "$BUN" run scripts/pulse/spinner/prove-stall-honesty.ts || fail=1
run_proof scripts/pulse/spinner/prove-display-dwell.ts "$BUN" run scripts/pulse/spinner/prove-display-dwell.ts || fail=1
run_proof scripts/pulse/spinner/prove-byline-priority.ts "$BUN" run scripts/pulse/spinner/prove-byline-priority.ts || fail=1
if [[ "${UI_RENDER:-}" == "1" ]]; then
  run_proof scripts/pulse/spinner/render-pulse-byline.ts "$BUN" run scripts/pulse/spinner/render-pulse-byline.tsx || fail=1
fi
exit "$fail"
