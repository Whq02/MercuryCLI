#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_RENDER_CWD
# gate-watch: assets/splash/mercury-splash.mjs src/boot/* src/boot/first-run/*
# gate-watch: src/commands/** src/engine/user-input/*
# gate-watch: src/integrations/skills/bundled/keybindings.ts src/models/roads/openai/openaiCallModel.ts
# gate-watch: src/models/roads/openai/openaiWire.ts src/models/sign-in/flow-cards/*
# gate-watch: src/models/sign-in/gemini-connect/* src/models/usage/*
# gate-watch: src/platform/config/schema.ts src/platform/shell/bash/shellSnapshot.ts
# gate-watch: src/screen/**
# gate-watch: src/tools/crewmate/*
# gate-watch: src/tools/edit/* src/tools/kit/*
# gate-watch: src/tools/notebook-edit/* src/tools/write/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/compositor-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'compositor-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members compositor-drives 'scripts/compositor/$name' "$here/members.txt"
