#!/usr/bin/env bash
# gate-class: exclusive
# gate-watch: src/ink/stringWidth* src/utils/truncate*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/proof-runner.sh"
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Mercury — micro-benchmark / perf-regression harness"
echo "############################################################"
run_proof "$here/bench-width.ts" "$bun" run "$here/bench-width.ts" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL BENCHMARKS WITHIN FLOOR"; else echo "# ❌ A BENCHMARK REGRESSED PAST ITS FLOOR"; fi
echo "############################################################"
exit "$fail"
