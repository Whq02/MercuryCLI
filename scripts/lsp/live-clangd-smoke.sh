#!/usr/bin/env bash
# live-clangd-smoke — the machine-dependent mercury-clangd leg (real clangd).
# RUN_LIVE=1 gated, mirrors scripts/dap/live-dap-smoke.sh: NEVER part of the
# deterministic gate (run-all.sh globs prove-*.ts only). Evidence log lives in
# the invoking session; the deterministic registry evidence is
# prove-clangd-lane.ts.
#   RUN_LIVE=1 bash scripts/lsp/live-clangd-smoke.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
if [ "${RUN_LIVE:-}" != "1" ]; then
  echo "live-clangd-smoke: set RUN_LIVE=1 to run against the real toolchain"
  exit 0
fi
RUN_LIVE=1 exec "$bun" run "$here/live-clangd-driver.ts"
