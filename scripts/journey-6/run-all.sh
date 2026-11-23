#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/journey/**
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/permissions/guards/mission.ts src/sessions/mission-card/missionCard.ts src/sessions/resume/sessionRestore.ts
# gate-watch: src/models/roads/anthropic/anthropicAdapter.ts src/models/roads/anthropic/anthropicCatalogue.ts src/models/roads/anthropic/anthropicClient.ts src/models/roads/anthropic/anthropicLogin.ts src/models/roads/anthropic/anthropicStream.ts src/models/roads/anthropic/anthropicUsageState.ts src/models/roads/anthropic/anthropicWorkspace.ts src/models/roads/anthropic/boundPrefixRecord.ts src/models/roads/anthropic/cacheAndUsage.ts src/models/roads/anthropic/cacheDiagnostics.ts src/models/roads/anthropic/index.ts src/models/roads/anthropic/media.ts src/models/roads/anthropic/messageEffort.ts src/models/roads/anthropic/messageParams.ts src/models/roads/anthropic/modelRefusal.ts src/models/roads/anthropic/prefixLedger.ts src/models/roads/anthropic/prefixRecordStore.ts src/models/roads/anthropic/requestParams.ts src/models/roads/anthropic/stream-core/** src/models/roads/anthropic/streamCore.ts src/models/roads/anthropic/thinkingBinding.ts src/models/roads/anthropic/thinkingDisplay.ts src/models/roads/anthropic/toolIds.ts src/models/roads/toolEconomy.ts src/engine/requests/dumpPrompts.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/journey-6"
if [ ! -f dist/mercury.mjs ]; then
  echo "❌ journey-6: dist/mercury.mjs absent — every member boots the built bundle; build first (~/.bun/bin/bun run build.ts)"
  exit 1
fi

failed=0
drive_members journey-6 'scripts/journey/$name' "$here/members.txt" '' run || failed=1

exit "$failed"
