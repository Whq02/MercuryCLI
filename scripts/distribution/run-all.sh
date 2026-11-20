#!/usr/bin/env bash
# gate-class: pure
# gate-watch: .node-version
# gate-watch: vendor/*.lock.json
# gate-watch: LICENSE.md TRADEMARKS.md
# gate-watch: scripts/lib/fixtureApi.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/distribution"
fail=0
echo "############################################################"
echo "# distribution — ownership record + distribution readiness"
echo "############################################################"
drive_members distribution 'scripts/distribution/$name' "$here/members.txt" || fail=1
if [ "$fail" -ne 0 ]; then
  echo "distribution suite: RED"
  exit 1
fi
echo "distribution suite: green"
