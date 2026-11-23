#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/motion/**
# gate-watch: assets/splash/** src/boot/main.tsx src/boot/setupScreens.tsx src/screen/composer/**
# gate-watch: src/screen/frame-chips/MercuryFrame.tsx src/screen/renderer/bindings/** src/screen/renderer/elements/MotionParkContext.ts src/screen/renderer/screenInstance.tsx
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
