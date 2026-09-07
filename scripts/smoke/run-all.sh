#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: build.ts src/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
here="$(cd "$(dirname "$0")" && pwd)"
fail=0
echo "############################################################"
echo "# Interactive mount smoke"
echo "############################################################"
if [ ! -f "$here/../../dist/mercury.mjs" ]; then
  echo "# ⚠ dist/mercury.mjs absent — skipping (build first to exercise this gate)"
else
  bun="${BUN:-$HOME/.bun/bin/bun}"
  "$bun" run "$here/prove-cli-verb-honesty.ts" || fail=1
  "$bun" run "$here/prove-mcp-verbs-truthful.ts" || fail=1
  "$bun" run "$here/prove-show-and-polyglot-honest.ts" || fail=1
  "$bun" run "$here/prove-headless-resume-honest.ts" || fail=1
  "$bun" run "$here/prove-config-write-contention.ts" || fail=1
  "$bun" run "$here/prove-field-w6-concourse-persist.ts" || fail=1
  "$bun" run "$here/prove-field-w6-flags.ts" || fail=1
fi
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ MOUNT SMOKE PASS"; else echo "# ❌ MOUNT SMOKE FAILED"; fi
echo "############################################################"
exit "$fail"
