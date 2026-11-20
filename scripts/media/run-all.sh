#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/host/** src/commands/llmhost/words.ts vendor/node.lock.json src/commands/imagesetup/** src/components/Settings/Config.tsx src/services/localServer/localServerTruth.ts
# gate-watch: src/extensions/**
# gate-watch: src/components/permissions/PermissionRequest.tsx
# gate-watch: src/ink.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/media"
fail=0
drive_members media 'scripts/media/$name' "$here/members.txt" || fail=1
exit "$fail"
