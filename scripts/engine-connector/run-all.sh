#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/**
# gate-watch: scripts/lib/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/engine-connector"

failed=0
drive_members engine-connector 'scripts/engine-connector/$name' "$here/members.txt" || failed=1

exit "$failed"
