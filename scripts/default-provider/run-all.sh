#!/usr/bin/env bash
# gate-class: pty
# scripts/default-provider/run-all.sh — the default-account-slot suite
# (/defaultprovider · the first-login law · the default-provider rung).
# gate-watch: src/utils/model/defaultProviderRung* src/commands/defaultprovider/**
# gate-watch: src/utils/model/model* src/components/ConsoleOAuthFlow* src/utils/config/schema*
set -u
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
