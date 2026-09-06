#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/daemon/**
# gate-watch: src/daemon/permissionAsks.ts src/daemon/concourseSupervisor.ts src/daemon/concourseDispatch.ts
# gate-watch: src/components/concourse/LiveNowCell.tsx src/services/engine-connector/crewFacts.ts
# gate-watch: src/services/engine-connector/daemonConnector.ts src/services/engine-connector/seatProjections.ts
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/daemon-drives"
if [ ! -f dist/mercury.mjs ]; then
  echo "❌ daemon-drives: dist/mercury.mjs absent — every member boots the built bundle; build first (~/.bun/bin/bun run build.ts)"
  exit 1
fi

failed=0
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  f="scripts/daemon/$name"
  if [ ! -e "$f" ]; then
    echo "❌ daemon-drives: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    failed=1
    continue
  fi
  echo "── daemon-drives: $name"
  __t=$SECONDS
  case "$name" in
    (*.py) /usr/bin/python3 "$f" || failed=1 ;;
    (*.sh) bash "$f" || failed=1 ;;
    (*) "$bun" "$f" || failed=1 ;;
  esac
  prover_mark "$f" "$__t"
done < "$here/members.txt"

exit "$failed"
