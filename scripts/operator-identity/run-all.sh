#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/** scripts/operator-identity/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Mercury operator identity"
echo "############################################################"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-operator-identity.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-operator-identity.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-identity-migration.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-identity-migration.ts" "$__t" "$__rc"

if [ "$fail" -ne 0 ]; then
  echo "❌ operator-identity suite RED"
  exit 1
fi
echo "✅ operator-identity suite green"
