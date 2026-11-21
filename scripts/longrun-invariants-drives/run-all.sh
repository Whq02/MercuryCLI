#!/usr/bin/env bash
# gate-class: pty
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/longrun-invariants-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'longrun-invariants-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members longrun-invariants-drives 'scripts/longrun-invariants/$name' "$here/members.txt"
