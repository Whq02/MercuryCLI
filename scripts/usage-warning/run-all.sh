#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/lib/captureDriver.ts scripts/lib/fixtureApi.ts scripts/ui/renderScenarios.ts scripts/ui/vshot.py src/cli/run.ts
# gate-watch: src/daemon/concourseWorkers.ts
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/proof-runner.sh"
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
overall=0
for suite in prove-usage-notice-setting prove-warning-tiers prove-provider-limit-warning prove-limit-warning-relay prove-limit-notice-in-context; do
  echo "── $suite"
  run_proof "$here/$suite.ts" "$bun" run "$here/$suite.ts"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    overall=1
    echo "── $suite FAILED (rc=$rc)"
  fi
done
exit "$overall"
