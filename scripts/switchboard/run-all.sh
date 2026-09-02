#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/switchboard/**
# gate-watch: src/services/concourse/** src/components/concourse/** src/daemon/concourseSupervisor.ts
# gate-watch: src/daemon/concourseDispatch.ts src/daemon/permissionAsks.ts src/services/switchboard/attachedSession.ts
# gate-watch: src/components/SwitchboardTagBar.tsx src/context/surfaceRoute.ts
# gate-watch: src/prompt/engineIdentity.ts src/constants/prompts.ts
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.."
bun="${BUN:-$HOME/.bun/bin/bun}"

failed=0
claimed=$(cat scripts/switchboard-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')
dupes=$(printf '%s\n' "$claimed" | sort | uniq -d)
if [ -n "$dupes" ]; then
  echo "❌ switchboard: prover(s) named by TWO sibling member lists (a double run across shards):"
  printf '%s\n' "$dupes" | sed 's/^/    /'
  failed=1
fi

shopt -s nullglob
for f in scripts/switchboard/prove-*.ts; do
  name=$(basename "$f")
  if printf '%s\n' "$claimed" | grep -qx "$name"; then
    continue
  fi
  echo "── switchboard: $name"
  __t=$SECONDS; if ! "$bun" "$f"; then
    failed=1
  fi
  prover_mark "$f" "$__t"
done

exit "$failed"
