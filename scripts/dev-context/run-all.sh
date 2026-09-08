#!/usr/bin/env bash
# gate-class: pure
# gate-watch: AGENTS.md CLAUDE.md scripts/dev-context/** scripts/git-hooks/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-root-guide.ts"; rc=$?; __rc=$rc; prover_mark "$here/prove-root-guide.ts" "$__t" "$__rc"
exit "$rc"
