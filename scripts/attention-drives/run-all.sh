#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/attention/**
# gate-watch: src/services/attention/** src/services/workbench/** src/input-core/**
# gate-watch: src/utils/sideQuestion.ts src/services/acp/** src/components/tasks/**
# gate-watch: scripts/engine-durability/harness.ts scripts/lib/captureDriver.ts
# gate-watch: scripts/streaming/artifactArena.ts scripts/ui/render-tui.ts
# gate-watch: src/components/mercury-ui/NavigablePanes.tsx src/components/mercury-ui/useNavigablePanes.ts
# gate-watch: src/components/prompts-panel/PromptsPanel.tsx src/keybindings/actionGraph.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/attention-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'attention-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members attention-drives 'scripts/attention/$name' "$here/members.txt"
