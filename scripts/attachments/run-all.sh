#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/engine/attachment-shapes/attachmentMessage.ts src/engine/attachment-shapes/attachmentTypes.ts src/engine/attachment-shapes/capsuleKinds.ts src/engine/attachment-shapes/capsuleState.ts src/engine/attachment-shapes/dateAndModeNotices.ts src/engine/attachment-shapes/fileReadDenied.ts src/engine/attachment-shapes/mentions.ts src/engine/attachment-shapes/missionStatus.ts src/engine/attachment-shapes/samplesRoad.ts src/engine/attachment-shapes/skillListing.ts src/engine/attachment-shapes/taskStatus.ts src/engine/attachment-shapes/userContext.ts
# gate-watch: src/sessions/project-intel/capsule.ts
# gate-watch: src/screen/composer/usePasteHandler.ts
# gate-watch: src/engine/system-prompt/defaultSystemPrompt.ts src/engine/system-prompt/systemPromptSections.ts
# gate-watch: src/sessions/transcripts/chain.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/attachments"
fail=0
echo "── context-assembly proofs ──"
drive_members attachments 'scripts/attachments/$name' "$here/members.txt" || fail=1
if [[ "$fail" == "0" ]]; then echo "✅ ATTACHMENTS SUITE GREEN"; exit 0; else
  echo "❌ ATTACHMENTS SUITE RED"; exit 1; fi
