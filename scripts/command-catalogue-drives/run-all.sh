#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_FEEDBACK_ROAD_CAPTURE_DIR
# gate-watch: README.md src/boot/* src/commands/** src/daemon/runner-wire/* src/engine/message-shapes/message.ts src/engine/rows/*
# gate-watch: src/engine/user-input/**
# gate-watch: src/platform/health/** src/platform/repo-host/** src/platform/secure-storage/**
# gate-watch: src/platform/update-channel/ghRelease.ts
# gate-watch: .github/ISSUE_TEMPLATE/** src/screen/composer/Composer.tsx src/screen/composer/ComposerFooterSuggestions.tsx
# gate-watch: mercury-skills/provider-apis/references/models.md
# gate-watch: src/screen/composer/typeahead/useTypeahead.tsx src/screen/help/**
# gate-watch: src/screen/widgets/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/command-catalogue-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'command-catalogue-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members command-catalogue-drives 'scripts/command-catalogue/$name' "$here/members.txt"
