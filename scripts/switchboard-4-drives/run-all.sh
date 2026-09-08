#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/switchboard/** scripts/switchboard-4/**
# gate-watch: src/services/concourse/** src/components/concourse/** src/daemon/concourseSupervisor.ts
# gate-watch: src/daemon/concourseDispatch.ts src/daemon/permissionAsks.ts src/services/switchboard/attachedSession.ts
# gate-watch: src/components/SwitchboardTagBar.tsx src/context/surfaceRoute.ts
# gate-watch: src/prompt/engineIdentity.ts src/constants/prompts.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/switchboard-4-drives"
if [ ! -f dist/mercury.mjs ]; then
  echo "❌ switchboard-4-drives: dist/mercury.mjs absent — every member boots the built bundle; build first (~/.bun/bin/bun run build.ts)"
  exit 1
fi

failed=0
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  f="scripts/switchboard/$name"
  if [ ! -e "$f" ]; then
    echo "❌ switchboard-4-drives: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    failed=1
    continue
  fi
  echo "── switchboard-4-drives: $name"
  __t=$SECONDS; __rc=0
  case "$name" in
    (*.py) /usr/bin/python3 "$f" || { __rc=$?; failed=1; } ;;
    (*.sh) bash "$f" || { __rc=$?; failed=1; } ;;
    (*) "$bun" "$f" || { __rc=$?; failed=1; } ;;
  esac
  prover_mark "$f" "$__t" "$__rc"
done < "$here/members.txt"

exit "$failed"
