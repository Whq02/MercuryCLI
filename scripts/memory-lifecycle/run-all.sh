#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/memdir/** src/services/mcp/coordinationServer* src/utils/backgroundHousekeeping* src/query/stopHooks* src/services/memoryUpkeep/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for proof in \
  prove-topic-memory-discoverability.ts \
  prove-topic-memory-correction.ts \
  prove-topic-memory-maintenance.ts \
  prove-memory-refs.ts \
  prove-themis-mission.ts \
; do
  echo "── $proof"
  __t=$SECONDS; __rc=0; if ! { "$BUN" run "$here/$proof"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    echo "❌ $proof FAILED"
    fail=1
  fi
  prover_mark "$here/$proof" "$__t" "$__rc"
done
if [ "$fail" -ne 0 ]; then
  echo "❌ memory-lifecycle suite: FAILURES"
  exit 1
fi
echo "✅ memory-lifecycle suite: ALL GREEN"
