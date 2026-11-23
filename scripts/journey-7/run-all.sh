#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/journey/**
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/engine/requests/dumpPrompts.ts src/models/roads/anthropic/** src/models/roads/toolEconomy.ts
# gate-watch: src/permissions/guards/* src/sessions/mission-card/* src/sessions/resume/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/journey-7"
if [ ! -f dist/mercury.mjs ]; then
  echo "❌ journey-7: dist/mercury.mjs absent — every member boots the built bundle; build first (~/.bun/bin/bun run build.ts)"
  exit 1
fi

failed=0
drive_members journey-7 'scripts/journey/$name' "$here/members.txt" '' run || failed=1

exit "$failed"
