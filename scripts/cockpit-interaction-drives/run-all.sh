#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/cockpit-interaction/**
# gate-watch: src/components/** src/keybindings/**
# gate-watch: src/input-core/command-queue* src/run-core/attachment-drain*
# gate-watch: src/run-core/turn-machine*
# gate-watch: src/services/providers/zai/** src/services/providers/zai/zaiAdapter.ts
# gate-watch: src/services/workbench/** src/utils/artifacts/** src/commands/diff/**
# gate-watch: scripts/engine-durability/bench-prompt-attribution.ts
# gate-watch: scripts/gate/ledger.ts scripts/lib/*
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/utils/cockpit/helmFocus.ts src/utils/cockpit/helmVitalsModel.ts
# gate-watch: src/Task.ts src/commands/workbench/workbench.tsx src/constants/subagentDoctrine.ts
# gate-watch: src/hooks/useTurnEndPing.ts src/ink/session/focus-store.ts
# gate-watch: src/ink/session/terminalProfile.ts src/ink/session/windowsHostSetup.ts src/services/attention/statusFeed.ts
# gate-watch: src/services/run/resolveOwner.ts src/skills/bundled/index.ts src/skills/bundledSkills.ts
# gate-watch: src/utils/config/globalConfig.ts src/utils/staticRender.tsx src/utils/toolSearch.ts src/utils/zodToJsonSchema.ts
# gate-watch: scripts/lib/observed_walk.py
# gate-watch: src/utils/analyzeContext.ts src/components/concourse/** src/components/mercury-ui/InteractiveRow.tsx
# gate-watch: src/screens/chat/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/cockpit-interaction-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'cockpit-interaction-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members cockpit-interaction-drives 'scripts/cockpit-interaction/$name' "$here/members.txt"
