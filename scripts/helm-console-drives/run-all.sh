#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_DRIVE_JOBS
# gate-watch: scripts/ui/render-tui.ts scripts/ui/vshot.py src/components/mercury-ui/glyphs*
# gate-watch: src/constants/spinnerVerbs* src/utils/cockpit/**
# gate-watch: scripts/helm-console/prove-console-render.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/helm-console-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'helm-console-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members helm-console-drives 'scripts/helm-console/$name' "$here/members.txt"
