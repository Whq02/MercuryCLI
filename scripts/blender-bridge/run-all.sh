#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/integrations/blender/** src/permissions/capability/**
# gate-watch: src/platform/images/*
# gate-watch: src/platform/processes/*
# gate-watch: src/tools/blender/** src/tools/read/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
here="$(cd "$(dirname "$0")" && pwd)"
fail=0
echo "############################################################"
echo "# blender-bridge — proof harness"
echo "############################################################"

if [ -f "$here/regen-bridge.mjs" ]; then
  echo
  echo ">>> regen-bridge --check"
  __t=$SECONDS; __rc=0; node "$here/regen-bridge.mjs" --check || { __rc=$?; fail=1; }; prover_mark "$here/regen-bridge.mjs" "$__t" "$__rc"
fi

drive_members blender-bridge 'scripts/blender-bridge/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL BLENDER-BRIDGE PROOFS PASS"; else echo "# ❌ SOME BLENDER-BRIDGE PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
