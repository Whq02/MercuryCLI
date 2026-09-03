#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/mission-runner/**
# gate-watch: scripts/mission-runner/**
# gate-watch: src/services/mission/** src/services/resources/adapters/mission.ts
# gate-watch: src/substrate/routerOutcomeStore.ts src/substrate/routerRunStore.ts
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/mission-runner-drives"
export MERCURY_EVOLUTION_LEDGER=0

if [ ! -f dist/mercury.mjs ]; then
  echo "❌ mission-runner-drives: dist/mercury.mjs absent — every member boots the built bundle; build first (~/.bun/bin/bun run build.ts)"
  exit 1
fi

failed=0
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  f="scripts/mission-runner/$name"
  if [ ! -e "$f" ]; then
    echo "❌ mission-runner-drives: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    failed=1
    continue
  fi
  echo "── mission-runner-drives: $name"
  __t=$SECONDS
  case "$name" in
    (*.py) /usr/bin/python3 "$f" || failed=1 ;;
    (*.sh) bash "$f" || failed=1 ;;
    (*) "$bun" "$f" || failed=1 ;;
  esac
  prover_mark "$f" "$__t"
done < "$here/members.txt"

exit "$failed"
