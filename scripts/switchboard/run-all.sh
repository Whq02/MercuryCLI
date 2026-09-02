#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/switchboard/**
# gate-watch: src/services/concourse/** src/components/concourse/** src/daemon/concourseSupervisor.ts
# gate-watch: src/daemon/concourseDispatch.ts src/daemon/permissionAsks.ts src/services/switchboard/attachedSession.ts
# gate-watch: src/components/SwitchboardTagBar.tsx src/context/surfaceRoute.ts
# gate-watch: src/prompt/engineIdentity.ts src/constants/prompts.ts
# The switchboard suite — the coordinator persona/turn laws, the
# W0 word-ban + composition laws, and the mirror grammar. THE RULED SPLIT:
# the estate is too large for any one CI ceiling, so the
# sibling sub-suites scripts/switchboard-2..-6 each run an explicit
# members.txt slice of scripts/switchboard/prove-*.ts, and THIS runner is
# the COMPLEMENT — every prover NOT named by a sibling list runs here, so a
# newly landed prove-*.ts joins the gate automatically (the suite-membership
# law: no orphan provers) and membership moves only by editing member lists.
# This runner is also the membership-law keeper: a name listed by TWO
# sibling lists (a double run across shards) is a red here.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
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
