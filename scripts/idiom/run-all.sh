#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/daemon/runner-wire/* src/engine/requests/apiCallLogging.ts
# gate-watch: src/engine/requests/apiErrorDetails.ts src/engine/requests/apiErrorRows.ts
# gate-watch: src/engine/requests/withRetry.ts src/engine/rows/*
# gate-watch: src/engine/tool-dispatch/* src/models/facts/tokenEstimation.ts
# gate-watch: src/models/roads/anthropic/anthropicClientFactory.ts src/models/roads/anthropic/cacheAndUsage.ts src/models/roads/anthropic/fixtureReplay.ts src/models/roads/anthropic/rateLimitMocking.ts src/models/roads/anthropic/requestParams.ts
# gate-watch: src/models/roads/anthropic/streamCore.ts src/models/roads/validateModel.ts src/platform/environment/* src/platform/storage/*
# gate-watch: src/sessions/transcripts/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/idiom"

failed=0
drive_members idiom 'scripts/idiom/$name' "$here/members.txt" || failed=1

exit "$failed"
