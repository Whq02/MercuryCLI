#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/harness-compare/** src/** build.ts
# The evaluation-hygiene suite: the product carries ZERO benchmark machinery —
# no src/ module references it, no env flag joins the runtime registry, and
# the shipped distributable contains no benchmark residue.
# Members (globbed — new prove-*.ts auto-join).
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for proof in "$here"/prove-*.ts; do
  name="$(basename "$proof")"
  echo "── harness-compare: $name"
  __t=$SECONDS; if ! "$bun" run "$proof"; then fail=1; fi; prover_mark "$proof" "$__t"
done
exit "$fail"
