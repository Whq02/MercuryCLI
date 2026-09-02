#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/unity/** src/services/ide/unityBridgeSession* src/tools/UnityTool/**
# gate-watch: src/utils/unity/** src/substrate/flagRegistry* src/substrate/startupMenu*
# gate-watch: src/utils/cockpit/harnessMap* assets/unity/bridge/**
# UNITY-BRIDGE (the Unity editor bridge, riding MERCURY_UNITY) — proof
# harness. Deterministic only: the scripted fake bridge + structural pins;
# neither Unity nor dotnet exists in any proof (compiles-in-editor is the
# written Windows-box field drill, never a step here). Regen drift checks run
# first once the bake lands; every scripts/unity-bridge/prove-*.ts runs via
# bun. run-all-suites.sh auto-joins this suite via its scripts/*/run-all.sh
# glob.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# unity-bridge — proof harness"
echo "############################################################"

if [ -f "$here/regen-bridge.mjs" ]; then
  echo
  echo ">>> regen-bridge --check"
  node "$here/regen-bridge.mjs" --check || fail=1
fi

shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL UNITY-BRIDGE PROOFS PASS"; else echo "# ❌ SOME UNITY-BRIDGE PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
