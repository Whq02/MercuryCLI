#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/attachments/**
# gate-watch: src/services/projectIntel/capsule.ts
# gate-watch: src/hooks/usePasteHandler*
# gate-watch: src/constants/prompts.ts src/constants/systemPromptSections.ts
# gate-watch: src/utils/sessionStorage/chain.ts
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
