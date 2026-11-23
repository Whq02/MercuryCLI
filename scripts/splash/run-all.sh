#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: assets/splash/** scripts/ui/vshot.py
# gate-watch: src/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
here="scripts/splash"
fail=0
echo "############################################################"
echo "# enter-screen splash — proof harness"
echo "############################################################"
__t=$SECONDS; __rc=0; node --check "$here/../../assets/splash/mercury-splash.mjs" || { __rc=$?; fail=1; }; prover_mark "assets/splash/mercury-splash.mjs" "$__t" "$__rc"
drive_members splash 'scripts/splash/$name' "$here/members.txt" || fail=1
if [ "$fail" -ne 0 ]; then
  echo "❌ splash suite: FAILURES"
  exit 1
fi
echo "✅ splash suite: ALL GREEN"
