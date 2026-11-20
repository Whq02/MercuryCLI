#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/sessionStorage/** src/utils/json*
# gate-watch: src/utils/envUtils* src/services/tools/toolExecution*
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/services/api/client.ts src/services/api/errorUtils.ts
# gate-watch: src/services/api/errors.ts src/services/api/logging.ts src/services/api/withRetry.ts src/services/providers/anthropic/cacheAndUsage.ts src/services/providers/anthropic/requestParams.ts
# gate-watch: src/services/providers/anthropic/streamCore.ts src/services/rateLimitMocking.ts src/services/tokenEstimation.ts src/services/vcr.ts
# gate-watch: src/utils/model/validateModel.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/idiom"

failed=0
drive_members idiom 'scripts/idiom/$name' "$here/members.txt" || failed=1

exit "$failed"
