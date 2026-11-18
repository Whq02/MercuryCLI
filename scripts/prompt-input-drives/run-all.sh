#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/prompt-input/**
# gate-watch: src/ink/input/**
# gate-watch: src/components/PromptInput/**
# gate-watch: src/input-core/** src/components/mercury-ui/useInteractiveList.ts
# gate-watch: src/utils/promptDraft.ts
# gate-watch: src/ink.ts src/components/design-system/ThemeProvider.tsx src/state/AppState.tsx src/keybindings/KeybindingProviderSetup.tsx src/components/mercury-ui/InteractiveRow.tsx
# gate-watch: src/components/InlineChangeView.tsx src/tools/StructureTool/**
# gate-watch: src/services/structure/** src/tools/LSPTool/**
# gate-watch: src/utils/Cursor.ts src/utils/inputRange.ts
# gate-watch: src/hooks/fileSuggestions.ts src/hooks/useTypeahead.tsx src/utils/suggestions/directoryCompletion.ts
# gate-watch: src/hooks/useHistorySearch.ts
# gate-watch: src/components/ScrollKeybindingHandler.tsx src/components/MercuryModelPicker.tsx
# gate-watch: src/components/HelmLanesRail.tsx
# gate-watch: scripts/lib/*
# gate-watch: src/hooks/useTextInput.ts src/ink/session/capabilities.ts
# gate-watch: src/utils/cwd.ts
# gate-watch: src/utils/suggestions/commandSuggestions.ts src/utils/truncate.ts
# gate-watch: src/utils/platform.ts
# gate-watch: src/hooks/usePasteHandler.ts src/components/BaseTextInput.tsx
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/prompt-input-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'prompt-input-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members prompt-input-drives 'scripts/prompt-input/$name' "$here/members.txt"
