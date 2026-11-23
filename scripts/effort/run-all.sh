#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/platform/config/** src/models/effort/effort.ts src/models/effort/effortLadder.ts src/models/effort/effortStamp.ts src/platform/settings/settings.ts src/platform/settings/settingsCache.ts
# gate-watch: src/screen/composer/Composer.tsx
# gate-watch: src/engine/attachment-shapes/attachmentMessage.ts src/engine/attachment-shapes/attachmentTypes.ts src/engine/attachment-shapes/capsuleKinds.ts src/engine/attachment-shapes/capsuleState.ts src/engine/attachment-shapes/dateAndModeNotices.ts src/engine/attachment-shapes/fileReadDenied.ts src/engine/attachment-shapes/mentions.ts src/engine/attachment-shapes/missionStatus.ts src/engine/attachment-shapes/samplesRoad.ts src/engine/attachment-shapes/skillListing.ts src/engine/attachment-shapes/taskStatus.ts src/engine/attachment-shapes/userContext.ts src/engine/messages/attachmentText.ts
# gate-watch: src/models/effort/thinking.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/effort"
fail=0
echo "############################################################"
echo "# effort — effort-module proofs"
echo "############################################################"
drive_members effort 'scripts/effort/$name' "$here/members.txt" || fail=1
if [ "$fail" -ne 0 ]; then
  echo "effort suite: RED"
  exit 1
fi
echo "effort suite: green"
