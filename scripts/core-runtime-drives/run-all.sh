#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/QueryEngine* src/boot/launchGraph* src/bootstrap/state* src/cli/headless/**
# gate-watch: src/cli/print* src/components/App* src/constants/betas* src/constants/oauth*
# gate-watch: src/entrypoints/agentSdkTypes* src/ink/** src/input-core/command-queue*
# gate-watch: src/input-core/pending-input* src/query/** src/replLauncher* src/screens/REPL*
# gate-watch: src/services/analytics/featureGates*
# gate-watch: src/services/providers/anthropic/** src/services/api/errors* src/services/api/withRetry*
# gate-watch: src/services/compact/autoCompact* src/services/tokenEstimation*
# gate-watch: src/state/AppStateStore* src/substrate/startupMenu* src/tools/AgentTool/constants*
# gate-watch: src/tools/BriefTool/prompt* src/tools/SyntheticOutputTool/SyntheticOutputTool*
# gate-watch: src/types/ids* src/types/textInputTypes* src/utils/**
# gate-watch: src/commands/caching/**
# The core-runtime real-terminal drives. The provers LIVE in scripts/core-runtime/ —
# this runner executes exactly the members named in members.txt, each a
# capture that boots the built bundle in a pseudo-terminal, so the
# deterministic provers stay in the core-runtime suite (the release verdict)
# while these report with the drives (their wall follows the runner). The
# parent runs every prover NOT named by a sibling member list; membership
# moves only by editing member lists, and the suite-class census
# (scripts/gate/prove-suite-class-census.ts) reds any drive left behind.
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/core-runtime-drives"
if [ ! -f dist/mercury.mjs ]; then
  echo "❌ core-runtime-drives: dist/mercury.mjs absent — every member boots the built bundle; build first (~/.bun/bin/bun run build.ts)"
  exit 1
fi

failed=0
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  f="scripts/core-runtime/$name"
  if [ ! -e "$f" ]; then
    echo "❌ core-runtime-drives: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    failed=1
    continue
  fi
  echo "── core-runtime-drives: $name"
  __t=$SECONDS
  case "$name" in
    (*.py) /usr/bin/python3 "$f" || failed=1 ;;
    (*.sh) bash "$f" || failed=1 ;;
    (*) "$bun" "$f" || failed=1 ;;
  esac
  prover_mark "$f" "$__t"
done < "$here/members.txt"

exit "$failed"
