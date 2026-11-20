#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/ink/input/** src/ink/events/input-event.ts
# gate-watch: src/components/PromptInput/**
# gate-watch: src/input-core/**
# gate-watch: src/components/InlineChangeView.tsx src/tools/StructureTool/**
# gate-watch: src/services/structure/** src/tools/LSPTool/**
# gate-watch: src/utils/inputRange.ts
# gate-watch: src/commands/model/mercuryModel.tsx
# gate-watch: src/components/MercuryModelPicker.tsx
# gate-watch: src/components/HelmLanesRail.tsx
# gate-watch: scripts/lib/* scripts/ui/renderScenarios.ts scripts/ui/vshot.py
# gate-watch: src/daemon/controlSocket.ts
# gate-watch: src/services/crew/obligations.ts
# gate-watch: src/components/mercury-ui/keyHintLabel.ts src/utils/platform.ts
# gate-watch: src/hooks/usePasteHandler.ts src/components/BaseTextInput.tsx src/daemon/controlSocket.ts scripts/streaming/ptydrive.py
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/prompt-input"
overall=0
drive_members prompt-input 'scripts/prompt-input/$name' "$here/members.txt" '' run || overall=1
exit $overall
