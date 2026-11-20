#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/engine-connector/**
# gate-watch: scripts/lib/*
# gate-watch: src/components/*
# gate-watch: src/components/mercury-ui/screens/*
# gate-watch: src/components/tasks/* src/daemon/*
# gate-watch: src/services/*
# gate-watch: src/tools/AgentTool/*
# gate-watch: src/utils/*
# gate-watch: src/rows/*
# gate-watch: src/services/health/sections/*
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/engine-connector"

failed=0
drive_members engine-connector 'scripts/engine-connector/$name' "$here/members.txt" || failed=1

exit "$failed"
