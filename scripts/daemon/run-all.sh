#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/utils/worktree.ts
# gate-watch: src/services/resources/adapters/health*
# gate-watch: src/tools/MonitorTool/** src/tools/ScheduleCronTool/**
# gate-watch: src/cli/run* src/services/saturn/** src/tools/ScheduleWakeupTool/**
# gate-watch: docs/SESSIONS.md scripts/journey/switch-fixture-server.ts
# gate-watch: scripts/lib/*
# gate-watch: scripts/streaming/turn-end-fixture-server.ts
# gate-watch: src/services/privateChannel/installLayout.ts
# gate-watch: src/rows/*
# gate-watch: src/components/Spinner/liveCounterWords.ts src/components/Spinner/spinnerHud.ts src/components/Spinner/SpinnerAnimationRow.tsx
# gate-watch: src/tasks/LocalAgentTask/* src/input-core/*
# gate-watch: src/services/providers/openaicompat/compatAdapter.ts
# gate-watch: src/commands/restart/* src/tasks/LocalShellTask/*
# gate-watch: src/services/providers/local/** src/services/providers/routeLaw.ts
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/daemon"
fail=0
echo "############################################################"
echo "# Mercury daemon — proof harness"
echo "############################################################"
drive_members daemon 'scripts/daemon/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL DAEMON PROOFS PASS"; else echo "# ❌ SOME DAEMON PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
