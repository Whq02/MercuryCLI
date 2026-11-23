#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/golden-journeys/**
# gate-watch: src/engine/run/** src/screen/workbench/** src/sessions/mission/** src/commands/run/** src/commands/diff/** src/commands/runs/** src/screen/prompts-panel/** src/screen/chat/Chat.tsx
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/golden-journeys-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'golden-journeys-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

fail=0
rm -f "${TMPDIR:-/tmp}"/momentum-report-*.json
drive_members golden-journeys-drives 'scripts/golden-journeys/$name' "$here/members.txt" || fail=1
for j in J1 J2 J3 J4 J5; do
  r="${TMPDIR:-/tmp}/momentum-report-${j}.json"
  if [ ! -s "$r" ]; then
    echo "❌ ${j}: no report written this run (${r})"
    fail=1
  fi
done
exit $fail
