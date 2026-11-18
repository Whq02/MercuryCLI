#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/motion/**
# gate-watch: src/ink/hooks/** src/ink/components/MotionParkContext.ts src/components/FullscreenLayout.tsx src/components/mercury-ui/components.tsx src/hooks/useArrowKeyHistory.tsx src/components/PromptInput/** assets/splash/**
# gate-watch: scripts/lib/captureDriver.ts scripts/streaming/artifactArena.ts
# gate-watch: src/utils/cockpit/greetingShimmer.ts
# gate-watch: src/utils/cockpit/motionGovernor.ts src/ink/root/frame-trace.ts src/ink/session/delivery.ts src/ink/ink.tsx src/interactiveHelpers.tsx src/main.tsx src/components/MercuryFrame.tsx
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/motion-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'motion-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members motion-drives 'scripts/motion/$name' "$here/members.txt"
