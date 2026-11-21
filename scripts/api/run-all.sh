#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/providers/anthropic/**
# gate-watch: src/services/providers/openai/** src/services/providers/zai/** src/services/providers/gemini/** src/services/providers/openrouter/**
# gate-watch: src/services/api/**
# gate-watch: scripts/lib/* src/*
# gate-watch: src/components/messages/AssistantTextMessage.tsx
# gate-watch: src/constants/*
# gate-watch: src/services/providers/*
# gate-watch: src/utils/*
# gate-watch: src/utils/messages/*
# gate-watch: src/utils/sessionStorage/*
# gate-watch: src/utils/settings/*
# gate-watch: src/services/crewBoard/seam.ts
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/utils/attachments/types.ts
# gate-watch: src/run-core/turn/**
# gate-watch: src/cli/headless/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/api"
fail=0
echo "── api-client proofs ──"
drive_members api 'scripts/api/$name' "$here/members.txt" || fail=1
if [[ "$fail" == "0" ]]; then echo "✅ API SUITE GREEN"; exit 0; else
  echo "❌ API SUITE RED"; exit 1; fi
