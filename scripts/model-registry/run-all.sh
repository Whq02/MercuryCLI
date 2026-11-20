#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/**
# gate-watch: scripts/lib/*
# gate-watch: src/components/*
# gate-watch: src/services/providers/* src/services/providers/anthropic/*
# gate-watch: src/services/vcr.ts src/services/api/client.ts
# gate-watch: src/services/providers/openai/*
# gate-watch: src/skills/bundled/provider-apis/** mercury-skills/provider-apis/**
# gate-watch: src/cli/headless/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/model-registry"
fail=0
drive_members model-registry 'scripts/model-registry/$name' "$here/members.txt" '' run || fail=1
exit "$fail"
