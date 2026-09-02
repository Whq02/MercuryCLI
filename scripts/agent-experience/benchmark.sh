#!/usr/bin/env bash
# scripts/agent-experience/benchmark.sh — the ONE entrypoint for the
# agent-experience benchmark. Mechanical legs by default (every provider
# family on the loopback fixture, zero spend); `--live` adds the one
# real-model leg on the operator's saved FREE OpenRouter default.
#
#   bash scripts/agent-experience/benchmark.sh                       # mechanical, all families
#   bash scripts/agent-experience/benchmark.sh --families anthropic  # one family
#   bash scripts/agent-experience/benchmark.sh --live                # + the live leg
#   bash scripts/agent-experience/benchmark.sh --live-only --tasks fix-bug,search-symbol
#   bash scripts/agent-experience/benchmark.sh --record mechanical   # refresh the committed baseline
#
# Requires the built bundle (dist/mercury.mjs): bun run build.ts.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
exec "$bun" run "$here/benchmark.ts" "$@"
