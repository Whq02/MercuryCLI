#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/components/** src/keybindings/**
# gate-watch: src/run-core/attachment-drain*
# gate-watch: src/run-core/turn-machine*
# gate-watch: src/tools/SleepTool/** src/services/providers/zai/**
# gate-watch: design-system/readme.md src/tools/**
# gate-watch: src/services/workbench/** src/utils/artifacts/** src/commands/diff/**
# gate-watch: scripts/lib/* scripts/ui/vshot.py
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/services/cockpit/helmLanesModel.ts
# gate-watch: src/constants/subagentDoctrine.ts
# gate-watch: src/interactiveHelpers.tsx
# gate-watch: src/services/run/resolveOwner.ts src/skills/bundled/index.ts src/skills/bundledSkills.ts
# gate-watch: src/utils/projectConfig.ts
# gate-watch: scripts/streaming/artifactArena.ts scripts/streaming/ptydrive.py scripts/streaming/screengrab.py scripts/lib/observed_walk.py
# gate-watch: src/services/context/analyzeContext.ts src/components/concourse/** src/components/mercury-ui/InteractiveRow.tsx
# gate-watch: scripts/notifications/concourseReferenceSeed.ts
# gate-watch: src/services/concourse/concourseSnapshot.ts
# gate-watch: scripts/ui/renderScenarios.ts
# gate-watch: src/tools/BashTool/** src/tools/PowerShellTool/**
# gate-watch: src/run-core/turn/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/cockpit-interaction"
fail=0

echo "############################################################"
echo "# cockpit-interaction — UI fluency, adaptive cockpit, platform parity"
echo "############################################################"

drive_members cockpit-interaction 'scripts/cockpit-interaction/$name' "$here/members.txt" || fail=1

exit "$fail"
