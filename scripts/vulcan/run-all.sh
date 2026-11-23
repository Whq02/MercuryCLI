#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
here="scripts/vulcan"
fail=0
echo "############################################################"
echo "# vulcan — proof harness"
echo "############################################################"

echo
echo ">>> regen-optable --check"
__t=$SECONDS; __rc=0; node "$here/regen-optable.mjs" --check || { __rc=$?; fail=1; }; prover_mark "$here/regen-optable.mjs" "$__t" "$__rc"

echo
echo ">>> regen-addon --check"
__t=$SECONDS; __rc=0; node "$here/regen-addon.mjs" --check || { __rc=$?; fail=1; }; prover_mark "$here/regen-addon.mjs" "$__t" "$__rc"

drive_members vulcan 'scripts/vulcan/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL VULCAN PROOFS PASS"; else echo "# ❌ SOME VULCAN PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
