#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_FEEDBACK_ROAD_CAPTURE_DIR
# gate-watch: src/commands/** src/components/HelpV2/** src/components/mercury-ui/** src/main* src/utils/processUserInput/** README.md
# gate-watch: src/types/message.ts
# gate-watch: src/hooks/useTypeahead.tsx src/components/PromptInput/PromptInput.tsx src/components/PromptInput/PromptInputFooterSuggestions.tsx
# gate-watch: src/utils/secureStorage/**
# gate-watch: src/services/repoHost/** src/services/privateChannel/ghRelease.ts .github/ISSUE_TEMPLATE/**
# gate-watch: mercury-skills/provider-apis/references/models.md
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/substrate/flagRegistry.ts
# gate-watch: src/services/health/**
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
