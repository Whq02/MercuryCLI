#!/usr/bin/env bash
# gate-class: pure
# gate-watch: assets/splash/** src/screen/renderer/staticRender.tsx src/screen/widgets/**
# gate-watch: scripts/ui/** scripts/critters/fixtures/** scripts/critters/zzzFrames.ts scripts/engine-connector/fixtures/**
# gate-watch: design-system/live/** scripts/lib/ptyRecorder.ts scripts/lib/distProvenance.ts
# gate-watch: scripts/engine-connector/prove-crew-token-rows.ts scripts/critters/prove-critter-sleep.ts scripts/visual-contract/baseline-capture.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
cd "$(dirname "$0")/../.." || exit 1
here="scripts/engine-pass"
fail=0
drive_members engine-pass 'scripts/engine-pass/$name' "$here/members.txt" || fail=1
exit "$fail"
