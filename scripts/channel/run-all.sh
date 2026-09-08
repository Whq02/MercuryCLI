#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/channel/** src/substrate/identity/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Mercury channel — the connection primitive"
echo "############################################################"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-channel-primitives.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-channel-primitives.ts" "$__t" "$__rc"

if [ "$fail" -ne 0 ]; then
  echo "❌ channel suite RED"
  exit 1
fi
echo "✅ channel suite green"
