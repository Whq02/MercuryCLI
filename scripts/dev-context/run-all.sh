#!/usr/bin/env bash
# gate-class: pure
# gate-watch: AGENTS.md CLAUDE.md scripts/dev-context/** scripts/git-hooks/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
__t=$SECONDS; "$bun" run "$here/prove-root-guide.ts"; rc=$?; prover_mark "$here/prove-root-guide.ts" "$__t"
exit "$rc"
