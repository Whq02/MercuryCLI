#!/usr/bin/env bash
# gate-class: pure
# gate-env: MERCURY_PROOF_POISON_GUARD MERCURY_PYTHON
# gate-watch: scripts/run-all-suites.sh scripts/typecheck/fingerprint.sed
# gate-watch: scripts/typecheck/prove-warm-replay.sh scripts/typecheck/run-all.sh
# gate-watch: .github/workflows/gate.yml .github/workflows/drives.yml scripts/*/run-all.sh scripts/*/members.txt
# gate-watch: scripts/lib/** scripts/ui/vshot.py
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/proof-runner.sh"
here="$(cd "$(dirname "$0")" && pwd)"
fail=0
echo "############################################################"
echo "# Gate machinery"
echo "############################################################"
run_proof "$here/prove-gate-runner.sh" bash "$here/prove-gate-runner.sh" || fail=1
run_proof "$here/prove-suite-env-guard.sh" bash "$here/prove-suite-env-guard.sh" || fail=1
run_proof "$here/prove-capture-preflight.ts" "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-capture-preflight.ts" || fail=1
run_proof "$here/prove-proof-exit-marks.ts" "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-proof-exit-marks.ts" || fail=1
run_proof "$here/prove-ci-shard-ceiling.sh" bash "$here/prove-ci-shard-ceiling.sh" || fail=1
run_proof "$here/prove-gate-scheduler.sh" bash "$here/prove-gate-scheduler.sh" || fail=1
run_proof "$here/prove-dead-letter-orphan.sh" bash "$here/prove-dead-letter-orphan.sh" || fail=1
run_proof "$here/prove-dist-cache.sh" bash "$here/prove-dist-cache.sh" || fail=1
run_proof "$here/prove-ci-verdict.sh" bash "$here/prove-ci-verdict.sh" || fail=1
run_proof "$here/prove-gate-ledger.ts" "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-gate-ledger.ts" || fail=1
run_proof "$here/prove-suite-class-census.ts" "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-suite-class-census.ts" || fail=1
run_proof "$here/prove-drives-plan.ts" "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-drives-plan.ts" || fail=1
run_proof "$here/prove-hermetic-shard.ts" "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-hermetic-shard.ts" || fail=1
run_proof "$here/../typecheck/prove-warm-replay.sh" bash "$here/../typecheck/prove-warm-replay.sh" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ GATE MACHINERY PASS"; else echo "# ❌ GATE MACHINERY FAILED"; fi
echo "############################################################"
exit "$fail"
