#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/components/PromptInput/** src/state/selectors* src/state/teammateViewHelpers*
# gate-watch: src/components/LiveStreamingTail* src/components/Messages* src/ink/** assets/splash/**
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1

failed=0
shopt -s nullglob
for f in scripts/render-continuity/prove-*.ts; do
  echo "── render-continuity: $(basename "$f")"
  __t=$SECONDS; if ! bun "$f"; then
    failed=1
  fi
  prover_mark "$f" "$__t"
done
for f in scripts/render-continuity/prove-*.py; do
  echo "── render-continuity: $(basename "$f")"
  __t=$SECONDS; if ! /usr/bin/python3 "$f"; then
    failed=1
  fi
  prover_mark "$f" "$__t"
done

exit "$failed"
