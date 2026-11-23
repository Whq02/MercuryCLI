#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/computer/prove-computer-*-drive.ts build.ts src/integrations/desktop/** src/platform/settings/* src/screen/composer/*
# gate-watch: scripts/computer/computerProofKit.ts scripts/computer/computerToolKit.ts scripts/lib/* native/desktop/src/{mac,win,x11,lib}.rs
# gate-watch: scripts/computer/fixtures/two-displays.json
# gate-watch: src/tools/computer/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/computer-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'computer-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

failed=0
drive_members computer-drives 'scripts/computer/$name' "$here/members.txt" || failed=1
exit "$failed"
