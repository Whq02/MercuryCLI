#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/daemon/runner/*
# gate-watch: src/engine/connector/seatProjections.ts src/engine/rows/turn.ts src/engine/run/**
# gate-watch: src/permissions/guards/structuredOutput.ts src/screen/composer/input-core/textInput.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/run"
fail=0
echo "############################################################"
echo "# run — autonomous-run kernel proof harness"
echo "############################################################"
drive_members run 'scripts/run/$name' "$here/members.txt" || fail=1
exit $fail
