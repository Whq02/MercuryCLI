#!/bin/bash
# gate-class: pure
# gate-watch: src/boot/**
# gate-watch: src/commands/**
# gate-watch: src/engine/user-input/*
# gate-watch: src/models/**
# gate-watch: src/screen/**
# gate-watch: src/tools/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/compositor"
fail=0
drive_members compositor 'scripts/compositor/$name' "$here/members.txt" '' run || fail=1

exit "$fail"
