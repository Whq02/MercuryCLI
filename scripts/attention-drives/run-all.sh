#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/attention/**
# gate-watch: src/integrations/acp/** src/screen/attention/** src/screen/composer/input-core/**
# gate-watch: src/screen/tasks/** src/screen/workbench/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/attention-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'attention-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members attention-drives 'scripts/attention/$name' "$here/members.txt"
