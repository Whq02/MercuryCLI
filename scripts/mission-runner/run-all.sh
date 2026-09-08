#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/mission-runner/**
# gate-watch: scripts/mission-runner/**
# gate-watch: src/services/mission/** src/services/resources/adapters/mission.ts
# gate-watch: src/substrate/routerOutcomeStore.ts src/substrate/routerRunStore.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
export MERCURY_EVOLUTION_LEDGER=0

claimed=$(cat scripts/mission-runner-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')

for proof in "$here"/prove-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")"; then continue; fi
  name="$(basename "$proof")"
  echo "── $name"
  __t=$SECONDS; __rc=0; if ! { "$bun" run "$proof"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    echo "❌ $name"
    fail=1
  fi
  prover_mark "$proof" "$__t" "$__rc"
done

exit "$fail"
