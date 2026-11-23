#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/engine/run/**
# gate-watch: src/models/roads/zai/zaiCallModel.ts
# gate-watch: scripts/stop-policy/*
# gate-watch: src/engine/loop/turn/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/stop-policy-boots"
if [ ! -f dist/mercury.mjs ]; then
  echo "❌ stop-policy-boots: dist/mercury.mjs absent — every member boots the built bundle; build first (~/.bun/bin/bun run build.ts)"
  exit 1
fi

failed=0
drive_members stop-policy-boots 'scripts/stop-policy/$name' "$here/members.txt" || failed=1

exit "$failed"
