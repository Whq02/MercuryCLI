#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/*
# gate-watch: src/components/* src/components/PromptInput/PromptInput.tsx
# gate-watch: src/hooks/*
# gate-watch: src/ink/squash-text-nodes.ts
# gate-watch: src/services/* src/services/api/*
# gate-watch: src/services/engine-connector/*
# gate-watch: src/utils/*
# gate-watch: src/utils/model/*
# gate-watch: src/commands/usage/usage.tsx
# gate-watch: src/ink/events/input-event.ts
# gate-watch: src/commands/effort/** src/services/host/recipesFile.ts assets/host/recipes.json
# gate-watch: src/services/llmHost/** src/commands/llmhost/**
# gate-watch: src/services/host/door.ts src/services/host/cluster.ts
# gate-watch: src/services/projectServices/contracts.ts
# gate-watch: src/run-core/turn/**
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/providers"
fail=0
echo "############################################################"
echo "# providers — readiness · usage truth · slot health"
echo "############################################################"
drive_members providers 'scripts/providers/$name' "$here/members.txt" || fail=1
exit "$fail"
