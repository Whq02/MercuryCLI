#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/utils/model/defaultProviderRung* src/commands/defaultprovider/**
# gate-watch: src/utils/model/model* src/components/ConsoleOAuthFlow* src/utils/config/schema*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
overall=0
for suite in prove-default-provider prove-defaultprovider-restart-drive; do
  echo "── $suite"
  "$bun" run "$here/$suite.ts"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    overall=1
    echo "── $suite FAILED (rc=$rc)"
  fi
done
exit "$overall"
