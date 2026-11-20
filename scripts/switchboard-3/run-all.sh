#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/switchboard/**
# gate-watch: src/services/concourse/** src/components/concourse/**
# gate-watch: src/daemon/permissionAsks.ts src/services/switchboard/attachedSession.ts
# gate-watch: src/components/SwitchboardTagBar.tsx src/context/surfaceRoute.ts
# gate-watch: src/constants/prompts.ts
# gate-watch: scripts/lib/*
# gate-watch: src/services/engine-connector/*
# gate-watch: src/services/providers/zai/zaiAdapter.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/switchboard-3"

failed=0
drive_members switchboard-3 'scripts/switchboard/$name' "$here/members.txt" || failed=1

exit "$failed"
