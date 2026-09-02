#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
BUN="${BUN:-$HOME/.bun/bin/bun}"

fail=0
"$BUN" run scripts/pulse/spinner/prove-stall-honesty.ts || fail=1
"$BUN" run scripts/pulse/spinner/prove-display-dwell.ts || fail=1
"$BUN" run scripts/pulse/spinner/prove-byline-priority.ts || fail=1
if [[ "${UI_RENDER:-}" == "1" ]]; then
  "$BUN" run scripts/pulse/spinner/render-pulse-byline.tsx || fail=1
fi
exit "$fail"
