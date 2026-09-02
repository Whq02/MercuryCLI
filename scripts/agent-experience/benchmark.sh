#!/usr/bin/env bash
set -u
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
exec "$bun" run "$here/benchmark.ts" "$@"
