#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_DRIVE_JOBS
# gate-watch: scripts/api/prove-prefix-frozen-drive.ts scripts/lib/fixtureApi.ts scripts/api/prove-image-refusal-drive.ts scripts/api/prove-image-refusal-frames.ts scripts/api/prove-authentication-retry-frames.ts scripts/api/authRetryFixture.ts scripts/api/authRetryNetworkFixture.cjs src/services/api/withRetry.ts src/services/api/errors.ts
# gate-watch: src/services/providers/anthropic/** src/services/providers/toolEconomy.ts src/constants/prompts.ts src/context.ts
# gate-watch: scripts/lib/captureDriver.ts src/daemon/controlSocket.ts
# gate-watch: scripts/api/prove-stream-cut-drive.ts scripts/api/streamCutFixture.mjs
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
