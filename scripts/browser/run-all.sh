#!/usr/bin/env bash
# gate-class: cpu
# gate-env: MERCURY_BROWSER_CACHE_DIR
# gate-watch: src/integrations/browser/** src/commands/browser/**
# gate-watch: scripts/vendor/patches/puppeteer-core@25.9.0.patch
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/browser"
fail=0
echo "############################################################"
echo "# browser — the driving surface suite"
echo "############################################################"
drive_members browser 'scripts/browser/$name' "$here/members.txt" || fail=1
exit "$fail"
