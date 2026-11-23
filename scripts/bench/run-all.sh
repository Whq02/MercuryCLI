#!/usr/bin/env bash
# gate-class: exclusive
# gate-env: MERCURY_BENCH_SLACK
# gate-watch: src/engine/rows/* src/daemon/runner-wire/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/bench"
fail=0
echo "############################################################"
echo "# Mercury — micro-benchmark / perf-regression harness"
echo "############################################################"
drive_members bench 'scripts/bench/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL BENCHMARKS WITHIN FLOOR"; else echo "# ❌ A BENCHMARK REGRESSED PAST ITS FLOOR"; fi
echo "############################################################"
exit "$fail"
