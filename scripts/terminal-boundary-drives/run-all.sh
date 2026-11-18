#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/terminal-boundary/**
# gate-watch: src/cli/run* src/utils/process.ts src/ink/components/ErrorOverview* src/ink/components/App.tsx src/components/RowErrorBoundary* src/main.tsx src/ink/launcherAltHold.ts src/entrypoints/cli.tsx
# gate-watch: src/components/** src/ink/session/querier.ts src/screens/**
# gate-watch: src/utils/gracefulShutdown.ts src/utils/sessionStorage/clearedSessions.ts
# gate-watch: src/rows/* src/runner/wire/* scripts/lib/rows.ts
# gate-watch: scripts/lib/runnerHost.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/terminal-boundary-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'terminal-boundary-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members terminal-boundary-drives 'scripts/terminal-boundary/$name' "$here/members.txt"
