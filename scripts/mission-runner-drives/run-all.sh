#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_DRIVE_JOBS
# gate-watch: scripts/mission-runner/** scripts/lib/rows.ts
# gate-watch: src/services/mission/** src/services/resources/adapters/mission.ts
# gate-watch: src/substrate/routerOutcomeStore.ts src/substrate/routerRunStore.ts
# gate-watch: src/services/providers/openai/openaiCatalogue.ts
# gate-watch: src/services/providers/openai/qualificationStore.ts src/utils/sessionStoragePortable.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
export MERCURY_EVOLUTION_LEDGER=0
here="scripts/mission-runner-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'mission-runner-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members mission-runner-drives 'scripts/mission-runner/$name' "$here/members.txt"
