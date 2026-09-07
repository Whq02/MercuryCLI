#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/prompt/** src/constants/prompts.ts scripts/behaviour-laws/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

for proof in "$here"/prove-*.ts; do
  name="$(basename "$proof")"
  echo "── $name"
  __t=$SECONDS; if ! "$bun" run "$proof"; then
    echo "❌ $name"
    fail=1
  fi
  prover_mark "$proof" "$__t"
done

exit "$fail"
