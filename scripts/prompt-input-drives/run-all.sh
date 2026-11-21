#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/prompt-input/**
# gate-watch: src/ink/input/**
# gate-watch: src/components/PromptInput/**
# gate-watch: src/input-core/**
# gate-watch: src/tools/StructureTool/**
# gate-watch: src/services/structure/** src/tools/LSPTool/**
# gate-watch: src/components/MercuryModelPicker.tsx
# gate-watch: src/components/HelmLanesRail.tsx
# gate-watch: scripts/lib/*
# gate-watch: src/hooks/useTextInput.ts
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
