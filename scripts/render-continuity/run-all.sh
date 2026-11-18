#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/components/PromptInput/** src/state/selectors* src/state/crewmateViewHelpers*
# gate-watch: src/ink/** assets/splash/**
# gate-watch: scripts/lib/* scripts/ui/vshot.py src/commands.ts
# gate-watch: src/components/tasks/* src/tasks/LocalAgentTask/LocalAgentTask.tsx
# gate-watch: src/utils/theme.ts
# gate-watch: scripts/ui/renderScenarios.ts
# gate-watch: src/utils/eventLoopStallDetector.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1

failed=0
shopt -s nullglob
claimed=$(members_cat scripts/render-continuity-*/members.txt)
for f in scripts/render-continuity/prove-*.ts; do
  printf '%s\n' "$claimed" | grep -qx "$(basename "$f")" && continue
  echo "── render-continuity: $(basename "$f")"
  __t=$SECONDS; __rc=0; if ! { bun "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    failed=1
  fi
  prover_mark "$f" "$__t" "$__rc"
done
for f in scripts/render-continuity/prove-*.py; do
  printf '%s\n' "$claimed" | grep -qx "$(basename "$f")" && continue
  echo "── render-continuity: $(basename "$f")"
  __t=$SECONDS; __rc=0; if ! { /usr/bin/python3 "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    failed=1
  fi
  prover_mark "$f" "$__t" "$__rc"
done

exit "$failed"
