#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/usage-warning/**
# gate-watch: src/services/providers/limitWarning* src/services/providers/usageTiers* src/hooks/notifs/useRateLimitWarningNotification*
# gate-watch: src/services/rateLimitMessages* src/services/providers/providerUsage*
# gate-watch: scripts/lib/captureDriver.ts scripts/lib/firstRunSeed.ts scripts/lib/fixtureApi.ts scripts/ui/renderScenarios.ts scripts/ui/vshot.py src/cli/run.ts
# gate-watch: src/services/mockRateLimits.ts src/daemon/concourseWorkers.ts src/daemon/protocol.ts src/services/capFailover.ts src/services/anthropicLimits.ts src/services/engine-connector/noSessionConnector.ts
# gate-watch: src/services/engine-connector/seatProjections.ts src/services/engine-connector/seatWire.ts src/services/engine-connector/types.ts src/services/mockRateLimits.ts src/services/oauth/client.ts src/services/providers/openai/openaiWire.ts
# gate-watch: src/services/providers/usageFreshness.ts src/utils/accounts/signInLedger.ts src/utils/attachments/sessionContext.ts src/utils/auth.ts src/utils/config.ts src/utils/config/globalConfig.ts src/utils/settings/types.ts src/utils/settings/settings.ts src/utils/settings/settingsCache.ts src/bootstrap/state*
# gate-watch: src/utils/messages/attachmentText.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/usage-warning-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'usage-warning-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members usage-warning-drives 'scripts/usage-warning/$name' "$here/members.txt"
