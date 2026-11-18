#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/streaming/ptydrive.py scripts/ui/render-tui.ts scripts/ui/vshot.py
# gate-watch: src/components/mercury-ui/**
# gate-watch: src/components/Mercury*.tsx
# gate-watch: src/commands/effort/effort.tsx
# gate-watch: src/components/concourse/ConcourseRoute.tsx
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1

BUN="${BUN:-$HOME/.bun/bin/bun}"
failures=0

run() {
  local name="$1"; shift
  echo "── $name"
  local __t=$SECONDS __rc=0 last
  for last; do :; done
  if ! { "$@"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    echo "❌ $name FAILED"
    failures=$((failures + 1))
  fi
  prover_mark "$last" "$__t" "$__rc"
}

run "nav-semantics" "$BUN" run scripts/navigation/prove-nav-semantics.ts
run "section-crossing" "$BUN" run scripts/navigation/prove-section-crossing.ts
run "focus-routing" "$BUN" run scripts/navigation/prove-focus-routing.ts
run "geometry" "$BUN" run scripts/navigation/prove-geometry.ts
run "input-compat" "$BUN" run scripts/navigation/prove-input-compat.ts
run "grapheme-corpus" "$BUN" run scripts/navigation/prove-grapheme-corpus.ts

if [ "$failures" -gt 0 ]; then
  echo "❌ navigation suite: $failures prover(s) RED"
  exit 1
fi
echo "✅ navigation suite GREEN"
