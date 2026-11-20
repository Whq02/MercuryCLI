#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/mission/** src/services/resources/adapters/mission.ts
# gate-watch: src/services/providers/openai/openaiCatalogue.ts
# gate-watch: src/services/providers/openai/qualificationStore.ts
# gate-watch: src/rows/* src/runner/wire/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/mission-runner"
fail=0
export MERCURY_EVOLUTION_LEDGER=0
drive_members mission-runner 'scripts/mission-runner/$name' "$here/members.txt" || fail=1

exit "$fail"
