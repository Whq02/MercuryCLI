#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/config/** src/utils/effort* src/utils/settings/settings*
# deepthink — the effort-module proof suite (turn-effort floor policy +
# wiring + the task-#11 persisted-default contract). Non-zero exit on any fail.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# deepthink — effort-module proofs"
echo "############################################################"
# Glob so new prove-*.ts auto-join.
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; "$bun" run "$f" || fail=1; prover_mark "$f" "$__t"
done
if [ "$fail" -ne 0 ]; then
  echo "deepthink suite: RED"
  exit 1
fi
echo "deepthink suite: green"
