#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/mission-runner/**
# gate-watch: scripts/mission-runner/**
# gate-watch: src/services/mission/** src/services/resources/adapters/mission.ts
# gate-watch: src/substrate/routerOutcomeStore.ts src/substrate/routerRunStore.ts
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
export MERCURY_EVOLUTION_LEDGER=0

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
