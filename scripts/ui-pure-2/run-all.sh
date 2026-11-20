#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/ui/**
# gate-watch: src/commands/run/runInspectorModel*
# gate-watch: src/commands/crew/index* src/context/overlayContext*
# gate-watch: src/daemon/** src/hooks/useCwdState* src/hooks/useFocusedWorkspaceCwd*
# gate-watch: src/services/anthropicLimits*
# gate-watch: src/utils/ripgrep.ts src/hooks/fileSuggestions.ts
# gate-watch: src/services/rateLimitMessages* src/services/run/**
# gate-watch: src/substrate/bootNotes*
# gate-watch: src/types/logs* src/utils/**
# gate-watch: scripts/lib/*
# gate-watch: src/*
# gate-watch: src/keybindings/*
# gate-watch: src/native-ts/color-diff/index.ts
# gate-watch: src/services/agents/*
# gate-watch: src/tools/AgentTool/* src/tools/FileEditTool/UI.tsx
# gate-watch: src/tools/FileWriteTool/UI.tsx
# gate-watch: src/services/engine-connector/types.ts
# gate-watch: src/screens/chat/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/ui-pure-2"

fail=0
drive_members ui-pure-2 'scripts/ui/$name' "$here/members.txt" '' run || fail=1

if [ "$fail" -eq 0 ]; then echo "✅ UI-PURE-2 SUITE GREEN"; else echo "❌ UI-PURE-2 SUITE RED"; fi
exit "$fail"
