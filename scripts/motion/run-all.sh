#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/ink/hooks/** src/ink/components/MotionParkContext.ts src/components/FullscreenLayout.tsx src/components/mercury-ui/components.tsx src/hooks/useArrowKeyHistory.tsx src/components/PromptInput/** assets/splash/**
# gate-watch: scripts/lib/captureDriver.ts scripts/streaming/artifactArena.ts
# gate-watch: src/utils/cockpit/greetingShimmer.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/motion"
fail=0
echo "── motion proofs ──"
drive_members motion 'scripts/motion/$name' "$here/members.txt" || fail=1
if [[ "$fail" == "0" ]]; then echo "✅ MOTION SUITE GREEN"; exit 0; else
  echo "❌ MOTION SUITE RED"; exit 1; fi
