#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/integrations/ide/*
# gate-watch: src/platform/substrate/*
# gate-watch: src/tools/unity/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
here="scripts/unity-bridge"
fail=0
echo "############################################################"
echo "# unity-bridge — proof harness"
echo "############################################################"

if [ -f "$here/regen-bridge.mjs" ]; then
  echo
  echo ">>> regen-bridge --check"
  __t=$SECONDS; __rc=0; node "$here/regen-bridge.mjs" --check || { __rc=$?; fail=1; }; prover_mark "$here/regen-bridge.mjs" "$__t" "$__rc"
fi

drive_members unity-bridge 'scripts/unity-bridge/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL UNITY-BRIDGE PROOFS PASS"; else echo "# ❌ SOME UNITY-BRIDGE PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
