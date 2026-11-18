#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_FEEDBACK_ROAD_CAPTURE_DIR
# gate-watch: src/commands.ts src/commands/** src/components/HelpV2/** src/components/mercury-ui/** src/types/command* src/main* src/utils/processUserInput/** README.md
# gate-watch: src/services/engine-connector/focusedConnector.ts src/services/engine-connector/noSessionConnector.ts src/utils/config/globalConfig.ts src/utils/config/trust.ts src/types/message.ts
# gate-watch: src/utils/suggestions/commandSuggestions.ts src/hooks/useTypeahead.tsx src/components/PromptInput/PromptInput.tsx src/components/PromptInput/PromptInputFooterSuggestions.tsx
# gate-watch: src/utils/redactSecrets.ts src/utils/secrets/secretScanner.ts src/utils/secureStorage/** src/services/providers/providerSecrets.ts src/utils/auth.ts src/services/providers/credentialEnvSpellings.ts
# gate-watch: src/components/Feedback.tsx src/services/repoHost/** src/services/privateChannel/ghRelease.ts .github/ISSUE_TEMPLATE/**
# gate-watch: mercury-skills/provider-apis/references/models.md package.json
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/utils/permissions/PermissionMode.ts
# gate-watch: src/substrate/flagRegistry.ts
# gate-watch: scripts/command-catalogue/fake-gh.mjs scripts/command-catalogue/prove-beta-journey-matrix.ts scripts/command-catalogue/prove-feedback-issue-road.ts scripts/lib/captureDriver.ts scripts/lib/firstRunSeed.ts scripts/lib/fixtureApi.ts
# gate-watch: scripts/ui/renderScenarios.ts scripts/ui/vshot.py src/services/privateChannel/channelCore.ts src/utils/config.ts src/utils/healthReport.ts
# gate-watch: src/utils/health/**
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
