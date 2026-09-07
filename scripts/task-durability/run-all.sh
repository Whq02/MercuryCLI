#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/task-durability/**
# gate-watch: src/substrate/durablePublish.ts src/substrate/fileStore.ts src/utils/tasks.ts
# gate-watch: src/services/privateChannel/installLayout.ts src/utils/errors/classifyToolError.ts
# gate-watch: src/services/changeTransaction/changeSetCommit.ts .github/workflows/windows-functional.yml
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"

failed=0
shopt -s nullglob
for f in scripts/task-durability/prove-*.ts; do
  echo "── task-durability: $(basename "$f")"
  __t=$SECONDS; if ! "$bun" "$f"; then
    failed=1
  fi
  prover_mark "$f" "$__t"
done

exit "$failed"
