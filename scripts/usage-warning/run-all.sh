#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/services/providers/limitWarning* src/hooks/notifs/useRateLimitWarningNotification*
# gate-watch: src/services/rateLimitMessages* src/services/providers/providerUsage*
set -u
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
overall=0
for suite in prove-provider-limit-warning prove-limit-warning-relay prove-warning-strip-captures prove-usage-pools-captures; do
  echo "── $suite"
  "$bun" run "$here/$suite.ts"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    overall=1
    echo "── $suite FAILED (rc=$rc)"
  fi
done
exit "$overall"
