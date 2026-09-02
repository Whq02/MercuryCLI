#!/usr/bin/env bash
set -u
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
if [ "${RUN_LIVE:-}" != "1" ]; then
  echo "live-clangd-smoke: set RUN_LIVE=1 to run against the real toolchain"
  exit 0
fi
RUN_LIVE=1 exec "$bun" run "$here/live-clangd-driver.ts"
