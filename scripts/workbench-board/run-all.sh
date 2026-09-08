#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/components/prompts-panel/**
# gate-watch: src/services/workbench/**
# gate-watch: src/services/workContexts/**
# gate-watch: src/utils/worktree.ts
# gate-watch: src/utils/cwd.ts
# gate-watch: src/services/walkthrough/**
# gate-watch: src/utils/artifacts/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

BUN="${BUN:-$HOME/.bun/bin/bun}"
cd "$(dirname "$0")/../.." || exit 1

fail=0
for f in scripts/workbench-board/prove-*.ts; do
  echo "── $f"
  __t=$SECONDS; __rc=0; "$BUN" run "$f" || { __rc=$?; fail=1; }; prover_mark "$f" "$__t" "$__rc"
done
exit $fail
