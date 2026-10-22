#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: docs/AUTOMATION.md docs/LLM-HOST.md docs/README.md scripts/lib/fixtureApi.ts scripts/lib/firstRunSeed.ts scripts/lib/runnerHost.ts src/cli/** src/commands/llmhost/** src/rows/** src/runner/** src/services/host/** src/services/providers/openaicompat/** src/utils/settings/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/proof-runner.sh"
here="$(cd "$(dirname "$0")" && pwd)"
fail=0
run_proof "$here/prove-automation-examples.ts" "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-automation-examples.ts" || fail=1
run_proof "$here/prove-llmhost-doc.ts" "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-llmhost-doc.ts" || fail=1
exit "$fail"
