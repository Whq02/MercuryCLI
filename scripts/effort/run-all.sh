#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/config/** src/utils/effort* src/utils/settings/settings*
# gate-watch: src/components/PromptInput/PromptInput.tsx
# gate-watch: src/utils/attachments/* src/utils/messages/attachmentText.ts
# gate-watch: src/utils/thinking.ts
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
