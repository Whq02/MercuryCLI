#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/search/** src/tools/WebSearchTool/** src/utils/config/**
# gate-watch: src/services/providers/openai/openaiWire* src/services/providers/openai/responsesBridge*
# gate-watch: src/utils/*
# gate-watch: src/rows/* src/runner/wire/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/search"
fail=0
drive_members search 'scripts/search/$name' "$here/members.txt" || fail=1
exit $fail
