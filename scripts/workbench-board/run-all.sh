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
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

BUN="${BUN:-$HOME/.bun/bin/bun}"
cd "$(dirname "$0")/../.."

fail=0
for f in scripts/workbench-board/prove-*.ts; do
  echo "── $f"
  __t=$SECONDS; "$BUN" run "$f" || fail=1; prover_mark "$f" "$__t"
done
exit $fail
