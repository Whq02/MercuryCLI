#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/field-tasks/**
# the difficult-work benchmark + causal-repair
# A THIN layer over the
# owners: mission specs, orchestration, closure proofs only.
# Provers are glob-run so every landed prove-*.ts joins the gate automatically.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.."
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
