#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/run-all-suites.sh scripts/typecheck/fingerprint.sed
# gate-watch: scripts/typecheck/prove-warm-replay.sh scripts/typecheck/run-all.sh
# Gate-machinery proofs — the parallel gate's own execution unit (run-suite.sh)
# is exercised against synthetic suites: rc propagation, output capture, and
# the watchdog tree-kill. Auto-joins scripts/run-all-suites.sh via the glob.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
fail=0
echo "############################################################"
echo "# Gate machinery"
echo "############################################################"
bash "$here/prove-gate-runner.sh" || fail=1
bash "$here/prove-ci-shard-ceiling.sh" || fail=1
bash "$here/prove-gate-scheduler.sh" || fail=1
bash "$here/prove-dist-cache.sh" || fail=1
bash "$here/prove-ci-verdict.sh" || fail=1
"${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-gate-ledger.ts" || fail=1
bash "$here/../typecheck/prove-warm-replay.sh" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ GATE MACHINERY PASS"; else echo "# ❌ GATE MACHINERY FAILED"; fi
echo "############################################################"
exit "$fail"
