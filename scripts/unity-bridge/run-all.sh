#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/unity/** src/services/ide/unityBridgeSession* src/tools/UnityTool/**
# gate-watch: src/utils/unity/** src/substrate/flagRegistry* src/substrate/startupMenu*
# gate-watch: src/utils/cockpit/harnessMap* assets/unity/bridge/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# unity-bridge — proof harness"
echo "############################################################"

if [ -f "$here/regen-bridge.mjs" ]; then
  echo
  echo ">>> regen-bridge --check"
  __t=$SECONDS; __rc=0; node "$here/regen-bridge.mjs" --check || { __rc=$?; fail=1; }; prover_mark "$here/regen-bridge.mjs" "$__t" "$__rc"
fi

shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL UNITY-BRIDGE PROOFS PASS"; else echo "# ❌ SOME UNITY-BRIDGE PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
