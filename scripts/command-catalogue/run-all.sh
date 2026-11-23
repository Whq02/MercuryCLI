#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/boot/* src/daemon/runner-wire/* src/engine/message-shapes/message.ts src/engine/rows/*
# gate-watch: src/engine/user-input/**
# gate-watch: src/platform/repo-host/**
# gate-watch: .github/ISSUE_TEMPLATE/** src/platform/secure-storage/** src/platform/update-channel/ghRelease.ts
# gate-watch: package.json
# gate-watch: src/screen/help/** src/screen/widgets/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/command-catalogue"
fail=0
drive_members command-catalogue 'scripts/command-catalogue/$name' "$here/members.txt" || fail=1
exit $fail
