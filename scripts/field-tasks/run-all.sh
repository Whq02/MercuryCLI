#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/field-tasks/**
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"

failed=0
shopt -s nullglob
for f in scripts/field-tasks/prove-*.ts; do
  echo "── field-tasks: $(basename "$f")"
  __t=$SECONDS; if ! "$bun" "$f"; then
    failed=1
  fi
  prover_mark "$f" "$__t"
done
for f in scripts/field-tasks/prove-*.py; do
  echo "── field-tasks: $(basename "$f")"
  __t=$SECONDS; if ! /usr/bin/python3 "$f"; then
    failed=1
  fi
  prover_mark "$f" "$__t"
done

exit "$failed"
