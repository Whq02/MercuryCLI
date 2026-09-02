#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/Tool* src/bootstrap/state* src/cli/print* src/cli/structuredIO*
# gate-watch: src/utils/hooks/sessionHooks* src/QueryEngine*
# scripts/headless/run-all.sh — the headless-engine proof suite. Globs
# prove-*.ts; auto-joins the pooled gate. Requires the prebuilt dist for the
# protocol legs.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# headless — control protocol + batching laws"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
exit $fail
