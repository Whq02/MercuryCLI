#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/cli/headless/**
# gate-watch: src/cli/run* src/components/App* src/constants/oauth*
# gate-watch: src/ink/**
# gate-watch: src/query/**
# gate-watch: src/services/providers/anthropic/**
# gate-watch: src/services/compact/autoCompact*
# gate-watch: src/types/ids* src/types/textInputTypes* src/utils/**
# gate-watch: src/commands/caching/**
# gate-watch: scripts/core-runtime/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/core-runtime-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'core-runtime-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members core-runtime-drives 'scripts/core-runtime/$name' "$here/members.txt"
