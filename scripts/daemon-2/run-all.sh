#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/daemon/**
# gate-watch: src/daemon/**
# gate-watch: src/services/resources/adapters/health*
# gate-watch: docs/DURABILITY.md
# gate-watch: src/services/concourse/concourseEnabled.ts
# gate-watch: src/tools/MonitorTool/** src/tools/ScheduleCronTool/**
# gate-watch: src/cli/headless/runnerAsks.ts src/cli/run* src/tools/ScheduleWakeupTool/**
# gate-watch: scripts/dap/mock-dap-adapter.mjs
# gate-watch: scripts/lib/* scripts/staleness/prove-stale-registry.ts
# gate-watch: scripts/ops/deploy-runtime.sh scripts/ops/launcher-mercury.sh scripts/ops/deploy-launcher.sh scripts/splash/deploy.sh docs/TERMINAL-RUNTIME.md
# gate-watch: src/services/privateChannel/installLayout.ts package.json
# gate-watch: src/rows/*
# gate-watch: scripts/lib/seatDoor.ts
# gate-watch: src/tasks/LocalAgentTask/* src/input-core/*
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/daemon-2"

fail=0
drive_members daemon-2 'scripts/daemon/$name' "$here/members.txt" '' run || fail=1
exit "$fail"
