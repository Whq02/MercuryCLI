#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/headless/**
# gate-watch: src/**
# gate-watch: scripts/lib/*
# gate-watch: sdk/src/rows.ts
# gate-watch: package.json
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/headless-6"

fail=0
drive_members headless-6 'scripts/headless/$name' "$here/members.txt" '' run || fail=1
exit "$fail"
