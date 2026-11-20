#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/providers/mistral/**
# gate-watch: src/services/providers/zen/**
# gate-watch: src/services/providers/patience.ts
# gate-watch: src/utils/model/providerFrontier.ts
# gate-watch: src/bootstrap/runtime/posture.ts
# gate-watch: src/utils/settings/**
# gate-watch: src/utils/fileRead*
# gate-watch: src/components/Settings/**
# gate-watch: src/utils/accounts/** src/services/oauth/**
# gate-watch: src/services/engine-connector/**
# gate-watch: scripts/ui/gridToPng.ts
# gate-watch: src/services/providers/openai/openaiCatalogue.ts src/hooks/useCatalogueEpoch.ts src/services/providers/huggingface/huggingfaceCatalogue.ts src/services/providers/local/localAccounts.ts src/components/ConfigurableShortcutHint.tsx
# gate-watch: src/*
# gate-watch: src/services/instructions/* src/services/instructions/adapters/**
# gate-watch: src/utils/permissions/filesystem.ts
# gate-watch: src/utils/*
# gate-watch: src/utils/cockpit/* src/utils/permissions/PermissionUpdate.ts
# gate-watch: src/services/providers/moonshot/** src/services/providers/huggingface/** src/services/providers/gemini/** src/services/providers/openrouter/** src/services/providers/local/** src/services/providers/openaicompat/** src/services/providers/deepseek/** src/services/providers/providerSecrets.ts
# gate-watch: src/services/localServer/**
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: scripts/ui/fixtures/settings-popup-header/*
# gate-watch: src/services/providers/nous/nousAccounts.ts
# gate-watch: src/utils/git.ts
# gate-watch: src/services/health/sections/crew.ts
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/settings"
fail=0
echo "############################################################"
echo "# settings — configuration pipeline proof harness"
echo "############################################################"
export TZ=UTC LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
drive_members settings 'scripts/settings/$name' "$here/members.txt" || fail=1
exit $fail
