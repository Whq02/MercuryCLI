#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/models/local-setup/** src/models/local-server/** src/models/roads/local/**
# gate-watch: src/commands/model/persistModelChoice.ts src/models/catalogue/modelTransition.ts src/platform/settings/settings.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/local-setup"
fail=0
export MERCURY_CREDENTIAL_STORE="${MERCURY_CREDENTIAL_STORE:-file}"
drive_members local-setup 'scripts/local-setup/$name' "$here/members.txt" || fail=1
echo
if [ "$fail" -eq 0 ]; then echo "LOCAL-SETUP SUITE GREEN"; else echo "LOCAL-SETUP SUITE RED"; fi
exit "$fail"
