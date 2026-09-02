#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: build.ts src/**
# Interactive mount smoke — launches the built fork TUI in a PTY and asserts it draws
# without a runtime crash (the class that bypassed every other gate: REPL.tsx is outside
# the strict typecheck floor, and -p/transcript proofs never mount the live REPL).
# Tests the CURRENT dist/mercury.mjs — the gate runs after a build. Auto-joins
# scripts/run-all-suites.sh via the scripts/*/run-all.sh glob. Non-zero exit on any fail.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
fail=0
echo "############################################################"
echo "# Interactive mount smoke"
echo "############################################################"
if [ ! -f "$here/../../dist/mercury.mjs" ]; then
  echo "# ⚠ dist/mercury.mjs absent — skipping (build first to exercise this gate)"
else
  /usr/bin/python3 "$here/mount-smoke.py" || fail=1
  # The headless-artifact honesty provers (each drives dist/mercury.mjs).
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
