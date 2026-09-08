#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/run-all-suites.sh scripts/typecheck/fingerprint.sed
# gate-watch: scripts/typecheck/prove-warm-replay.sh scripts/typecheck/run-all.sh
# gate-watch: .github/workflows/gate.yml .github/workflows/drives.yml scripts/*/run-all.sh scripts/*/members.txt
# gate-watch: scripts/lib/suite-env.sh scripts/lib/captureDriver.ts scripts/lib/capturePreflight.ts scripts/ui/vshot.py
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
here="$(cd "$(dirname "$0")" && pwd)"
fail=0
echo "############################################################"
echo "# Gate machinery"
echo "############################################################"
bash "$here/prove-gate-runner.sh" || fail=1
bash "$here/prove-suite-env-guard.sh" || fail=1
"${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-capture-preflight.ts" || fail=1
bash "$here/prove-ci-shard-ceiling.sh" || fail=1
bash "$here/prove-gate-scheduler.sh" || fail=1
bash "$here/prove-dead-letter-orphan.sh" || fail=1
bash "$here/prove-dist-cache.sh" || fail=1
bash "$here/prove-ci-verdict.sh" || fail=1
"${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-gate-ledger.ts" || fail=1
"${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-suite-class-census.ts" || fail=1
"${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-drives-plan.ts" || fail=1
"${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-hermetic-shard.ts" || fail=1
bash "$here/../typecheck/prove-warm-replay.sh" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ GATE MACHINERY PASS"; else echo "# ❌ GATE MACHINERY FAILED"; fi
echo "############################################################"
exit "$fail"
