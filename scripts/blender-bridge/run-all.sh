#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/blender/** src/services/ide/blenderBridgeSession* src/tools/BlenderTool/**
# gate-watch: src/utils/blender/** src/substrate/flagRegistry* src/substrate/startupMenu*
# gate-watch: src/utils/cockpit/harnessMap* assets/blender/bridge/**
# BLENDER-BRIDGE (the Blender add-on bridge, riding MERCURY_BLENDER) — proof
# harness. Deterministic only: the scripted fake bridge + structural pins;
# Blender never exists in any proof (runs-in-Blender is the written Mac
# drill, never a step here). Regen drift checks run first once the bake
# lands; every scripts/blender-bridge/prove-*.ts runs via bun.
# run-all-suites.sh auto-joins this suite via its scripts/*/run-all.sh glob.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# blender-bridge — proof harness"
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
if [ "$fail" = "0" ]; then echo "# ✅ ALL BLENDER-BRIDGE PROOFS PASS"; else echo "# ❌ SOME BLENDER-BRIDGE PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
