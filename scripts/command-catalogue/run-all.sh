#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/components/HelpV2/** src/components/mercury-ui/** src/main* src/services/processUserInput/**
# gate-watch: src/types/message.ts
# gate-watch: src/utils/secureStorage/**
# gate-watch: src/services/repoHost/** src/services/privateChannel/ghRelease.ts .github/ISSUE_TEMPLATE/**
# gate-watch: package.json
# gate-watch: src/rows/* src/runner/wire/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/command-catalogue"
fail=0
drive_members command-catalogue 'scripts/command-catalogue/$name' "$here/members.txt" || fail=1
exit $fail
