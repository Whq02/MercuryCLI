#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/services/api/withRetry.ts src/services/api/errors.ts
# gate-watch: src/services/providers/anthropic/** src/services/providers/toolEconomy.ts src/constants/prompts.ts src/context.ts
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
