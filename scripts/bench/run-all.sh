#!/usr/bin/env bash
# gate-class: exclusive
# gate-watch: src/ink/stringWidth* src/utils/truncate*
# ============================================================================
#  scripts/bench/run-all.sh — Mercury micro-benchmark harness.
#
#  The improvement-chain (the scribe/fable/perf/bench
#  plan) wanted a FIRST-CLASS benchmark surface, not an afterthought. This is the
#  tractable, deterministic, no-live-API subset: pure-logic micro-benchmarks that
#  double as PERF-REGRESSION GUARDS (each asserts an ops/sec floor so a future
#  change that 10×-slows a hot primitive goes RED, not silently slower).
#
#  NOT here (need API credentials / a live turn → measured out-of-band): scribe
#  dispatch→result throughput, real render frame timing.
#  Those are recorded; the
#
#  Run:  bash scripts/bench/run-all.sh         (joins the gate via the glob)
#  Floors are generous (CI-machine slack); they catch ORDER-OF-MAGNITUDE
#  regressions, not noise. Tune via MERCURY_BENCH_SLACK (default 1).
# ============================================================================
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Mercury — micro-benchmark / perf-regression harness"
echo "############################################################"
"$bun" run "$here/bench-width.ts" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL BENCHMARKS WITHIN FLOOR"; else echo "# ❌ A BENCHMARK REGRESSED PAST ITS FLOOR"; fi
echo "############################################################"
exit "$fail"
