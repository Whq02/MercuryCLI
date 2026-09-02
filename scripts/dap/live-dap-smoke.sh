#!/usr/bin/env bash
# ============================================================================
# live-dap-smoke.sh — REAL-debugger smoke for the DAP client. Prefers the
# native leg (clang -g + lldb-dap, resolved via xcrun) and falls back to
# debugpy when lldb-dap is absent; skips honestly when neither exists.
# NOT gate-joined (host-toolchain dependent; the deterministic protocol proof
# is prove-dap.ts). Local only — no API cost; RUN_LIVE=1 keeps it explicit.
#
# First GREEN run: (lldb-dap from CommandLineTools, darwin) — see
# record subsequent runs in the pass notes.
# ============================================================================
set -u
if [ "${RUN_LIVE:-0}" != "1" ]; then
  echo "live-dap-smoke: local real-debugger smoke — set RUN_LIVE=1 to run (never gate-joined)."
  exit 0
fi
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
scratch="$(mktemp -d /tmp/dap-smoke.XXXXXX)"

LLDB_DAP="$(xcrun -f lldb-dap 2>/dev/null || command -v lldb-dap || true)"

# SMOKE_LEG forces one leg (native | python | js); default keeps the standing
# preference (native, else python). The js leg exercises the multi-session
# child road against the REAL js-debug — the driver routes every debuggee op
# to the stopped MEMBER, so the same loop holds on all three.
leg="${SMOKE_LEG:-}"
if [ "$leg" = "js" ]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "live-dap-smoke: SKIP — SMOKE_LEG=js needs node on PATH."
    exit 0
  fi
  js_dap="${MERCURY_JS_DEBUG_DAP:-}"
  if [ -z "$js_dap" ] && [ -f "$repo/dist/vendor/js-debug/src/dapDebugServer.js" ]; then
    # The vendored tree boots IN PLACE: the module-class fence (the
    # {"type":"commonjs"} package.json the build writes) self-classifies
    # the CJS bundle even inside this type:module repo.
    js_dap="$repo/dist/vendor/js-debug/src/dapDebugServer.js"
  fi
  if [ -z "$js_dap" ] && [ -f "$HOME/.js-debug/js-debug/src/dapDebugServer.js" ]; then
    js_dap="$HOME/.js-debug/js-debug/src/dapDebugServer.js"
  fi
  if [ -z "$js_dap" ]; then
    echo "live-dap-smoke: SKIP — SMOKE_LEG=js needs a js-debug resolution (MERCURY_JS_DEBUG_DAP, a built dist/vendor/js-debug, or ~/.js-debug)."
    exit 0
  fi
  echo "— js leg: node + js-debug ($js_dap)"
  cat > "$scratch/demo.cjs" <<'EOF'
function compute(a, b) {
  const total = a * 10 + b
  return total
}
const x = compute(4, 2)
console.log('result:', x)
EOF
  export SMOKE_ADAPTER=js
  export SMOKE_PROGRAM="$scratch/demo.cjs"
  export SMOKE_SOURCE="$scratch/demo.cjs"
  export SMOKE_LINE=2
  export SMOKE_FRAME=compute
  export MERCURY_DAP_ADAPTERS="{\"js\":{\"command\":\"$(command -v node)\",\"args\":[\"$js_dap\",\"\${port}\",\"127.0.0.1\"],\"connect\":\"tcp\",\"launchDefaults\":{\"type\":\"pwa-node\"},\"attachDefaults\":{\"type\":\"pwa-node\"}}}"
elif { [ -z "$leg" ] || [ "$leg" = "native" ]; } && [ -n "$LLDB_DAP" ] && command -v clang >/dev/null 2>&1; then
  echo "— native leg: clang -g + lldb-dap ($LLDB_DAP)"
  cat > "$scratch/demo.c" <<'EOF'
#include <stdio.h>
int compute(int a, int b) {
  int total = a * 10 + b;
  return total;
}
int main(void) {
  int x = compute(4, 2);
  printf("result: %d\n", x);
  return 0;
}
EOF
  clang -g -O0 -o "$scratch/demo" "$scratch/demo.c"
  export SMOKE_ADAPTER=native
  export SMOKE_PROGRAM="$scratch/demo"
  export SMOKE_SOURCE="$scratch/demo.c"
  export SMOKE_LINE=3
  export SMOKE_FRAME=compute
  export MERCURY_DAP_ADAPTERS="{\"native\":{\"command\":\"$LLDB_DAP\",\"args\":[]}}"
elif { [ -z "$leg" ] || [ "$leg" = "python" ]; } && python3 -c 'import debugpy' 2>/dev/null; then
  echo "— python leg: debugpy"
  cat > "$scratch/demo.py" <<'EOF'
def compute(a, b):
    total = a * 10 + b
    return total

if __name__ == "__main__":
    x = compute(4, 2)
    print("result:", x)
EOF
  export SMOKE_ADAPTER=python
  export SMOKE_PROGRAM="$scratch/demo.py"
  export SMOKE_SOURCE="$scratch/demo.py"
  export SMOKE_LINE=2
  export SMOKE_FRAME=compute
else
  echo "live-dap-smoke: SKIP — neither lldb-dap nor debugpy available. prove-dap.ts (mock) remains the standing evidence."
  exit 0
fi

cd "$repo" && "$bun" run scripts/dap/live-dap-driver.ts
status=$?
rm -rf "$scratch"
if [ "$status" = "0" ]; then echo "LIVE DAP SMOKE GREEN"; else echo "LIVE DAP SMOKE FAILED"; fi
exit "$status"
