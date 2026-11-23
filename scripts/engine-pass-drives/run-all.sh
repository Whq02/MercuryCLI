#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/engine-pass/**
# gate-watch: assets/splash/** src/screen/renderer/staticRender.tsx src/screen/widgets/**
# gate-watch: scripts/ui/** scripts/critters/fixtures/** scripts/critters/zzzFrames.ts scripts/engine-connector/fixtures/**
# gate-watch: design-system/live/**
# gate-watch: scripts/critters/prove-critter-sleep.ts scripts/visual-contract/baseline-capture.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/engine-pass-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'engine-pass-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members engine-pass-drives 'scripts/engine-pass/$name' "$here/members.txt"
