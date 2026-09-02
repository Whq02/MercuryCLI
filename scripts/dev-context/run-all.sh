#!/usr/bin/env bash
# gate-class: pure
# gate-watch: AGENTS.md CLAUDE.md scripts/dev-context/** scripts/git-hooks/**
# The root-guide suite: AGENTS.md is the one root guide and stays a screen
# long, CLAUDE.md only points at it, no tool-specific developer estate is
# tracked, and the commit-msg hook keeps session metadata out of history.
# Auto-joins scripts/run-all-suites.sh (which globs scripts/*/run-all.sh).
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
__t=$SECONDS; "$bun" run "$here/prove-root-guide.ts"; rc=$?; prover_mark "$here/prove-root-guide.ts" "$__t"
exit "$rc"
