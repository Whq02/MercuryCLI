#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/daemon/runner-wire/* src/engine/rows/*
# gate-watch: src/integrations/resources/adapters/mission.ts
# gate-watch: src/models/roads/openai/openaiCatalogue.ts
# gate-watch: src/models/roads/openai/qualificationStore.ts src/sessions/mission/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/mission-runner"
fail=0
export MERCURY_EVOLUTION_LEDGER=0
drive_members mission-runner 'scripts/mission-runner/$name' "$here/members.txt" || fail=1

exit "$fail"
