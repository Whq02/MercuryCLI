#!/usr/bin/env bash
# ============================================================================
# live-native-debug-smoke.sh — REAL-toolchain smoke for the slice-5
# native-debugging expansion: clang -g fixture → launch via lldb-dap →
# conditional breakpoint stops only when true → function breakpoint →
# disassemble/readMemory when advertised → instruction step → clean exit.
# NOT gate-joined (host-toolchain dependent; the deterministic contract lives
# in prove-native-debug.ts). Local only — no API cost; RUN_LIVE=1 keeps it
# explicit. Record green runs in the slice notes.
# ============================================================================
set -u
if [ "${RUN_LIVE:-0}" != "1" ]; then
  echo "live-native-debug-smoke: local real-debugger smoke — set RUN_LIVE=1 to run (never gate-joined)."
  exit 0
fi
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"

LLDB_DAP="$(xcrun -f lldb-dap 2>/dev/null || command -v lldb-dap || true)"
if [ -z "$LLDB_DAP" ]; then
  echo "live-native-debug-smoke: SKIP — no lldb-dap (xcrun -f lldb-dap / PATH). prove-native-debug.ts (mock) remains the standing evidence."
  exit 0
fi
if ! command -v clang >/dev/null 2>&1; then
  echo "live-native-debug-smoke: SKIP — no clang to build the -g fixture."
  exit 0
fi

scratch="$(mktemp -d /tmp/native-debug-smoke.XXXXXX)"
trap 'rm -rf "$scratch"' EXIT

cat > "$scratch/demo.c" <<'EOF'
#include <stdio.h>

int accumulate(int i, int total) {
  total = total + i;
  return total;
}

int main(void) {
  int total = 0;
  for (int i = 0; i < 5; i++) {
    total = accumulate(i, total);
  }
  printf("total: %d\n", total);
  return 0;
}
EOF
clang -g -O0 -o "$scratch/demo" "$scratch/demo.c" || { echo "clang build failed"; exit 1; }

export SMOKE_PROGRAM="$scratch/demo"
export SMOKE_SOURCE="$scratch/demo.c"
export SMOKE_LINE=4
export MERCURY_DAP_ADAPTERS="{\"native\":{\"command\":\"$LLDB_DAP\",\"args\":[]}}"

echo "— native leg: clang -g + lldb-dap ($LLDB_DAP)"
cd "$repo" && "$bun" run scripts/ide/live-native-debug-driver.ts
status=$?
if [ "$status" = "0" ]; then echo "LIVE NATIVE DEBUG SMOKE GREEN"; else echo "LIVE NATIVE DEBUG SMOKE FAILED"; fi
exit "$status"
