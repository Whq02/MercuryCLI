#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/models/roads/anthropic/anthropicAdapter.ts src/models/roads/anthropic/anthropicCatalogue.ts src/models/roads/anthropic/anthropicClient.ts src/models/roads/anthropic/anthropicLogin.ts src/models/roads/anthropic/anthropicStream.ts src/models/roads/anthropic/anthropicUsageState.ts src/models/roads/anthropic/anthropicWorkspace.ts src/models/roads/anthropic/boundPrefixRecord.ts src/models/roads/anthropic/cacheAndUsage.ts src/models/roads/anthropic/cacheDiagnostics.ts src/models/roads/anthropic/index.ts src/models/roads/anthropic/media.ts src/models/roads/anthropic/messageEffort.ts src/models/roads/anthropic/messageParams.ts src/models/roads/anthropic/modelRefusal.ts src/models/roads/anthropic/prefixLedger.ts src/models/roads/anthropic/prefixRecordStore.ts src/models/roads/anthropic/requestParams.ts src/models/roads/anthropic/stream-core/** src/models/roads/anthropic/streamCore.ts src/models/roads/anthropic/thinkingBinding.ts src/models/roads/anthropic/thinkingDisplay.ts src/models/roads/anthropic/toolIds.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/api-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'api-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members api-drives 'scripts/api/$name' "$here/members.txt"
