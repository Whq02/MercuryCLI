#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/engine-connector/**
# gate-watch: src/services/engine-connector/** src/hooks/useSessionConnector.ts
# gate-watch: src/screens/REPL.tsx src/components/MercuryFrame.tsx src/components/PromptInput/**
# gate-watch: src/components/permissions/** src/hooks/useCancelRequest.ts src/hooks/useDisplayedSessionModel.ts
# The engine-connector real-terminal drives. The provers LIVE in scripts/engine-connector/ —
# this runner executes exactly the members named in members.txt, each a
# capture that boots the built bundle in a pseudo-terminal, so the
# deterministic provers stay in the engine-connector suite (the release verdict)
# while these report with the drives (their wall follows the runner). The
# parent runs every prover NOT named by a sibling member list; membership
# moves only by editing member lists, and the suite-class census
# (scripts/gate/prove-suite-class-census.ts) reds any drive left behind.
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/engine-connector-drives"
if [ ! -f dist/mercury.mjs ]; then
  echo "❌ engine-connector-drives: dist/mercury.mjs absent — every member boots the built bundle; build first (~/.bun/bin/bun run build.ts)"
  exit 1
fi

failed=0
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  f="scripts/engine-connector/$name"
  if [ ! -e "$f" ]; then
    echo "❌ engine-connector-drives: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    failed=1
    continue
  fi
  echo "── engine-connector-drives: $name"
  __t=$SECONDS
  case "$name" in
    (*.py) /usr/bin/python3 "$f" || failed=1 ;;
    (*.sh) bash "$f" || failed=1 ;;
    (*) "$bun" "$f" || failed=1 ;;
  esac
  prover_mark "$f" "$__t"
done < "$here/members.txt"

exit "$failed"
