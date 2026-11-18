#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/default-provider/**
# gate-watch: src/utils/model/defaultProviderRung* src/commands/defaultprovider/**
# gate-watch: src/utils/model/model* src/components/ConsoleOAuthFlow* src/utils/config/schema*
# gate-watch: scripts/lib/captureDriver.ts scripts/ui/vshot.py src/services/providers/routeLaw.ts src/utils/accounts/signInLedger.ts src/utils/config.ts src/utils/model/computedDefault.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/default-provider-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'default-provider-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members default-provider-drives 'scripts/default-provider/$name' "$here/members.txt"
