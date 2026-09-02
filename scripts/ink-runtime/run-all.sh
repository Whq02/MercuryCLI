#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/ink/**
# ink-runtime — the native terminal-runtime ownership suite
# — facade inventory · input byte corpus · layout
# scene corpus (the engine oracle) · frame composition goldens. Non-zero exit
# on any fail.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# ink-runtime — native terminal-runtime ownership proofs"
echo "############################################################"
# Glob so new prove-*.ts auto-join.
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; "$bun" run "$f" || fail=1; prover_mark "$f" "$__t"
done
if [ "$fail" -ne 0 ]; then
  echo "ink-runtime suite: RED"
  exit 1
fi
echo "ink-runtime suite: green"
