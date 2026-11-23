#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/default-provider/**
# gate-watch: src/commands/defaultprovider/**
# gate-watch: src/models/facts/* src/models/sign-in/flow-cards/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/default-provider-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'default-provider-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members default-provider-drives 'scripts/default-provider/$name' "$here/members.txt"
