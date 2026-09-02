#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/switchboard/** scripts/switchboard-3/**
# gate-watch: src/services/concourse/** src/components/concourse/** src/daemon/concourseSupervisor.ts
# gate-watch: src/daemon/concourseDispatch.ts src/daemon/permissionAsks.ts src/services/switchboard/attachedSession.ts
# gate-watch: src/components/SwitchboardTagBar.tsx src/context/surfaceRoute.ts
# gate-watch: src/prompt/engineIdentity.ts src/constants/prompts.ts
# The switchboard estate, sub-suite 3 of the ruled split: the
# provers LIVE in scripts/switchboard/ — this runner executes exactly the
# members named in members.txt so no single suite can wedge a CI shard past
# the hang law's ceiling. New provers join the PARENT suite automatically
# (the complement runner); membership moves only by editing member lists.
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/switchboard-3"

failed=0
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  f="scripts/switchboard/$name"
  if [ ! -e "$f" ]; then
    echo "❌ switchboard-3: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    failed=1
    continue
  fi
  echo "── switchboard-3: $name"
  __t=$SECONDS; if ! "$bun" "$f"; then
    failed=1
  fi
  prover_mark "$f" "$__t"
done < "$here/members.txt"

exit "$failed"
