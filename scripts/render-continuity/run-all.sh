#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/components/PromptInput/** src/state/selectors* src/state/teammateViewHelpers*
# gate-watch: src/components/LiveStreamingTail* src/components/Messages* src/ink/** assets/splash/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1

failed=0
shopt -s nullglob
for f in scripts/render-continuity/prove-*.ts; do
  echo "── render-continuity: $(basename "$f")"
  __t=$SECONDS; __rc=0; if ! { bun "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    failed=1
  fi
  prover_mark "$f" "$__t" "$__rc"
done
for f in scripts/render-continuity/prove-*.py; do
  echo "── render-continuity: $(basename "$f")"
  __t=$SECONDS; __rc=0; if ! { /usr/bin/python3 "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    failed=1
  fi
  prover_mark "$f" "$__t" "$__rc"
done

exit "$failed"
