#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/commands/model/mercuryModel.tsx
# gate-watch: src/commands/model/picker/MercuryModelPicker.tsx
# gate-watch: src/platform/environment/platform.ts
# gate-watch: src/screen/composer/**
# gate-watch: src/screen/fullscreen-layout/HelmLanesRail.tsx src/screen/renderer/input/**
# gate-watch: src/tools/engines/structure/**
# gate-watch: src/tools/lsp/**
# gate-watch: src/tools/structure/**
# gate-watch: scripts/lib/* scripts/ui/renderScenarios.ts scripts/ui/vshot.py
# gate-watch: scripts/streaming/ptydrive.py
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/prompt-input"
overall=0
drive_members prompt-input 'scripts/prompt-input/$name' "$here/members.txt" '' run || overall=1
exit $overall
