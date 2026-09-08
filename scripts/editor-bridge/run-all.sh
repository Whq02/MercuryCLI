#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/editor-bridge/**
# gate-watch: src/services/workbench/** src/services/resources/adapters/workbench.ts
# gate-watch: src/services/acp/** src/services/workContexts/** src/services/walkthrough/**
# gate-watch: src/utils/artifacts/** src/components/diff/** src/components/prompts-panel/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"

prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

bun=${BUN:-$HOME/.bun/bin/bun}
cd "$(dirname "$0")/../.." || exit 1

red=0
for proof in scripts/editor-bridge/prove-*.ts; do
  echo "== $proof"
  __t=$SECONDS; __rc=0; if ! { "$bun" run "$proof"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    echo "RED: $proof"
    red=1
  fi
  prover_mark "$proof" "$__t" "$__rc"
done

exit "$red"
