#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/*
# gate-watch: src/components/* src/components/PromptInput/PromptInput.tsx
# gate-watch: src/hooks/*
# gate-watch: src/ink/squash-text-nodes.ts
# gate-watch: src/services/* src/services/api/*
# gate-watch: src/services/engine-connector/*
# gate-watch: src/utils/*
# gate-watch: src/utils/model/*
# gate-watch: src/commands/usage/usage.tsx
# gate-watch: src/ink/events/input-event.ts
# gate-watch: src/commands/effort/** src/services/host/recipesFile.ts assets/host/recipes.json
# gate-watch: src/services/llmHost/** src/commands/llmhost/**
# gate-watch: src/services/host/door.ts src/services/host/cluster.ts
# gate-watch: src/services/projectServices/contracts.ts
# gate-watch: src/run-core/turn/**
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# providers — readiness · usage truth · slot health"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
for mode in reasoning sglang; do
  __t=$SECONDS; __rc=0; "$bun" run "$here/prove-llmhost-wire.ts" "$mode" || { __rc=$?; fail=1; }; prover_mark "$here/prove-llmhost-wire.ts ($mode)" "$__t" "$__rc"
done
exit "$fail"
