#!/usr/bin/env bash
# gate-class: exclusive
# gate-watch: src/ink/stringWidth* src/utils/truncate*
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
