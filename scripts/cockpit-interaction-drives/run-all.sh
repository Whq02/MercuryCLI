#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/cockpit-interaction/**
# gate-watch: src/components/** src/keybindings/**
# gate-watch: src/utils/mercuryTokens* src/utils/helmDensity* src/utils/helmGeometry*
# gate-watch: src/utils/transcriptSearch* src/utils/cockpit/cockpitActivity*
# gate-watch: src/input-core/command-queue* src/run-core/attachment-drain*
# gate-watch: src/run-core/turn-machine*
# gate-watch: src/tools/SleepTool/** src/services/providers/zai/** src/services/providers/zai/zaiAdapter.ts
# gate-watch: src/screens/Chat* design-system/readme.md src/tools.ts src/tools/**
# gate-watch: src/services/workbench/** src/utils/artifacts/** src/commands/diff/**
# gate-watch: src/services/concourse/workerTranscript.ts
# gate-watch: scripts/engine-durability/bench-prompt-attribution.ts scripts/engine-durability/harness.ts
# gate-watch: scripts/gate/ledger.ts scripts/lib/* scripts/ui/vshot.py
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/utils/cockpit/helmLanesModel.ts src/utils/cockpit/helmFocus.ts src/utils/cockpit/helmVitalsModel.ts
# gate-watch: src/Task.ts src/bootstrap/state.ts src/commands/workbench/workbench.tsx src/constants/subagentDoctrine.ts
# gate-watch: src/context/overlayStack.ts src/hooks/useTurnEndPing.ts src/ink.ts src/ink/root/frame-trace.ts src/ink/session/focus-store.ts
# gate-watch: src/ink/session/terminalProfile.ts src/ink/session/windowsHostSetup.ts src/interactiveHelpers.tsx src/services/attention/statusFeed.ts
# gate-watch: src/services/run/resolveOwner.ts src/skills/bundled/index.ts src/skills/bundledSkills.ts src/utils/cockpit/critterData.ts
# gate-watch: src/utils/config/globalConfig.ts src/utils/projectConfig.ts src/utils/staticRender.tsx src/utils/toolSearch.ts src/utils/zodToJsonSchema.ts
# gate-watch: scripts/streaming/artifactArena.ts scripts/streaming/ptydrive.py scripts/streaming/screengrab.py scripts/lib/observed_walk.py scripts/lib/fixtureApi.ts scripts/lib/firstRunSeed.ts
# gate-watch: src/commands/context/context.tsx src/utils/analyzeContext.ts src/components/concourse/** src/components/mercury-ui/InteractiveRow.tsx src/daemon/controlSocket.ts src/utils/sessionStorage/paths.ts
# gate-watch: scripts/notifications/concourseReferenceSeed.ts
# gate-watch: src/services/concourse/concourseSnapshot.ts src/services/concourse/workerTranscript.ts
# gate-watch: scripts/ui/renderScenarios.ts
# gate-watch: src/tools/BashTool/** src/tools/PowerShellTool/**
# gate-watch: src/screens/chat/*
# gate-watch: scripts/ui/chatScenarios.ts
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
