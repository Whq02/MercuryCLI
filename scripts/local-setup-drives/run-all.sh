#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/local-setup/fixtures/**
# gate-watch: src/models/local-setup/** src/commands/localsetup/**
# gate-watch: src/models/local-server/** src/models/roads/local/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/local-setup-drives"
dist="${MERCURY_DIST:-dist/mercury.mjs}"
if [ ! -f "$dist" ]; then
  printf 'local-setup-drives: bundle absent at %s; run bun run build.ts before the suite\n' "$dist"
  exit 1
fi

failed=0
drive_members local-setup-drives 'scripts/local-setup/$name' "$here/members.txt" || failed=1

exit "$failed"
