#!/usr/bin/env bash
# gate-class: pure
# gate-watch: vendor/node.lock.json src/commands/imagesetup/** src/commands/llmhost/words.ts src/integrations/extensions/** src/models/hosting/** src/models/local-server/localServerTruth.ts
# gate-watch: src/screen/*
# gate-watch: src/screen/settings/Config.tsx
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/media"
fail=0
drive_members media 'scripts/media/$name' "$here/members.txt" || fail=1
exit "$fail"
