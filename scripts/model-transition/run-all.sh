#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/model-transition/**
# gate-watch: src/utils/model/modelTransition.ts src/services/run/requestContextPlan.ts
# gate-watch: src/fabric/** src/utils/sessionStorage/** src/services/providers/**
# gate-watch: src/services/branches/** src/services/run/contextSelection.ts
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"

failed=0
shopt -s nullglob
for f in scripts/model-transition/prove-*.ts; do
  echo "── model-transition: $(basename "$f")"
  __t=$SECONDS; if ! "$bun" "$f"; then
    failed=1
  fi
  prover_mark "$f" "$__t"
done

exit "$failed"
