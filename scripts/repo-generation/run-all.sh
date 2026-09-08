#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/substrate/flagRegistry* src/substrate/themis/workflowHost* src/tools/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# DAEDALUS repo-generation workflow — proof harness"
echo "############################################################"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-repo-generation-host.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-repo-generation-host.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-repo-generation-script.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-repo-generation-script.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-repo-generation-registration.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-repo-generation-registration.ts" "$__t" "$__rc"
if [ "$fail" -ne 0 ]; then
  echo "❌ repo-generation suite: FAILURES"
  exit 1
fi
echo "✅ repo-generation suite: ALL GREEN"
