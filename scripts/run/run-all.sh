#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/run/**
# gate-watch: src/cli/run.ts src/cli/headless/runnerMethods.ts src/cli/headless/controlHandlers.ts
# gate-watch: src/rows/turn.ts src/types/textInputTypes.ts
# gate-watch: src/guards/structuredOutput.ts src/services/engine-connector/seatProjections.ts
# gate-watch: src/cli/headless/*
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
