#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/engine/system-prompt/apolloMode.ts src/engine/system-prompt/behaviourContract.ts src/engine/system-prompt/composer.ts src/engine/system-prompt/mercuryContract.ts src/engine/system-prompt/recordedComposition.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/wrapper"
fail=0
echo "############################################################"
echo "# Mercury behavioural contract — floor presence + antisyc arm"
echo "############################################################"

drive_members wrapper 'scripts/wrapper/$name' "$here/members.txt" || fail=1

exit "$fail"
