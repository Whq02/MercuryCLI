#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/switchboard/**
# gate-watch: src/daemon/switchboard/attachedSession.ts
# gate-watch: src/engine/connector/*
# gate-watch: scripts/lib/*
# gate-watch: src/models/roads/zai/zaiAdapter.ts
# gate-watch: src/screen/concourse/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/switchboard-3"

failed=0
drive_members switchboard-3 'scripts/switchboard/$name' "$here/members.txt" || failed=1

exit "$failed"
