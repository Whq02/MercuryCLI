#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/services/providers/limitWarning* src/services/providers/usageTiers* src/hooks/notifs/useRateLimitWarningNotification*
# gate-watch: src/services/rateLimitMessages* src/services/providers/providerUsage*
# gate-watch: scripts/lib/captureDriver.ts scripts/lib/firstRunSeed.ts scripts/lib/fixtureApi.ts scripts/ui/renderScenarios.ts scripts/ui/vshot.py src/cli/run.ts
# gate-watch: src/services/mockRateLimits.ts src/daemon/concourseSupervisor.ts src/daemon/protocol.ts src/services/capFailover.ts src/services/claudeAiLimits.ts src/services/engine-connector/noSessionConnector.ts
# gate-watch: src/services/engine-connector/seatProjections.ts src/services/engine-connector/seatWire.ts src/services/engine-connector/types.ts src/services/mockRateLimits.ts src/services/oauth/client.ts src/services/providers/openai/openaiWire.ts
# gate-watch: src/services/providers/usageFreshness.ts src/utils/accounts/signInLedger.ts src/utils/attachments/sessionContext.ts src/utils/auth.ts src/utils/config.ts src/utils/config/globalConfig.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/proof-runner.sh"
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
overall=0
for suite in prove-warning-tiers prove-provider-limit-warning prove-limit-warning-relay prove-limit-notice-in-context prove-warning-strip-captures prove-usage-pools-captures prove-usage-freshness-captures prove-mock-limits-per-model-captures; do
  echo "── $suite"
  run_proof "$here/$suite.ts" "$bun" run "$here/$suite.ts"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    overall=1
    echo "── $suite FAILED (rc=$rc)"
  fi
done
exit "$overall"
