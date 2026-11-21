#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/providers/openai/**
# gate-watch: src/services/providers/openaicompat/**
# gate-watch: src/services/providers/openrouter/** src/utils/settings/**
# gate-watch: src/services/providers/huggingface/** src/services/providers/local/**
# gate-watch: src/utils/model/pins/glmPins* src/services/providers/**
# gate-watch: src/types/message.ts
# gate-watch: src/services/providers/gemini/** src/services/providers/xai/** src/services/providers/meta/**
# gate-watch: src/services/providers/mistral/**
# gate-watch: src/services/providers/zen/** src/services/providers/zen/zenAdapter.ts
# gate-watch: src/services/providers/groq/** src/services/providers/cerebras/** src/services/providers/fireworks/**
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/services/providers/nous/**
# gate-watch: src/services/providers/minimax/** src/services/providers/together/** src/services/providers/cohere/**
# gate-watch: src/services/providers/melious/**
# gate-watch: src/services/engine-connector/seatLive.ts
# gate-watch: src/services/health/healthReport.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/provider-compat"
fail=0
echo "############################################################"
echo "# provider-compat — multi-provider proof harness"
echo "############################################################"
echo "# Engine request contracts: prove-engine-shapes.ts and prove-tool-schemas-no-refs.ts"
drive_members provider-compat 'scripts/provider-compat/$name' "$here/members.txt" || fail=1
exit "$fail"
