#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/prompt-input/**
# gate-watch: src/commands/model/picker/MercuryModelPicker.tsx
# gate-watch: src/platform/environment/platform.ts
# gate-watch: src/screen/composer/**
# gate-watch: src/screen/fullscreen-layout/HelmLanesRail.tsx
# gate-watch: src/screen/renderer/input/** src/tools/engines/structure/**
# gate-watch: src/tools/lsp/**
# gate-watch: src/tools/structure/**
# gate-watch: scripts/lib/*
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
