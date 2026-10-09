#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_DRIVE_JOBS
# gate-watch: assets/splash/** scripts/ui/vshot.py src/substrate/startupMenu*
# gate-watch: scripts/splash/prove-splash.py
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/splash-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'splash-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members splash-drives 'scripts/splash/$name' "$here/members.txt"
