#!/usr/bin/env bash
# scripts/pulse/spinner/run-all.sh — the spinner sub-suite.
# NOTE: nested one level below scripts/*/run-all.sh, so the pooled gate does
# NOT glob this directly — the integrator's scripts/pulse/run-all.sh calls it.
# Render legs join under UI_RENDER=1 (the ui-suite convention).
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
