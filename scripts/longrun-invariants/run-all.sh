#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/cli/run.ts
# gate-watch: src/components/mercury-ui/theme.ts
# gate-watch: src/components/messages/* src/components/tasks/* src/daemon/*
# gate-watch: src/hooks/* src/main.tsx
# gate-watch: src/services/engine-connector/*
# gate-watch: src/services/run/* src/state/*
# gate-watch: src/tasks/LocalShellTask/LocalShellTask.tsx
# gate-watch: src/tools/AgentTool/*
# gate-watch: src/tools/PowerShellTool/PowerShellTool.tsx
# gate-watch: src/utils/*
# gate-watch: src/utils/attachments/* src/utils/hooks/*
# gate-watch: src/utils/sessionStorage/*
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/guards/**
# gate-watch: src/cli/headless/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/longrun-invariants"

fail=0
drive_members longrun-invariants 'scripts/longrun-invariants/$name' "$here/members.txt" || fail=1

if [ "$fail" -eq 0 ]; then
  echo "✅ longrun-invariants suite green"
else
  echo "❌ longrun-invariants suite RED"
fi
exit "$fail"
