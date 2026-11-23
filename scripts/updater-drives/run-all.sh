#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/release/package.mjs
# gate-watch: src/models/roads/privacyLevel.ts src/engine/requests/clientContractLearned.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/updater-drives"

failed=0
drive_members updater-drives 'scripts/updater/$name' "$here/members.txt" || failed=1

exit "$failed"
