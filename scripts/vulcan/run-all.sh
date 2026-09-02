#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/constants/subagentDoctrine* src/services/vulcan/** src/substrate/flagRegistry*
# gate-watch: src/substrate/startupMenu* src/tools/** src/utils/cwd* src/utils/cockpit/harnessMap*
# gate-watch: src/utils/vulcan/optable.generated* src/utils/vulcan/vulcanGates*
# VULCAN (the native Godot editor-control surface, MERCURY_GODOT_TOOLS) —
# proof harness. Deterministic only (fake NDJSON server + structural pins;
# the real-editor smoke lives in live-vulcan-smoke.sh, RUN_LIVE-gated, never
# here). Regen drift checks run first; every scripts/vulcan/prove-*.ts runs
# via bun. run-all-suites.sh auto-joins this suite via its scripts/*/run-all.sh
# glob.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# vulcan — proof harness"
echo "############################################################"

echo
echo ">>> regen-optable --check"
node "$here/regen-optable.mjs" --check || fail=1

echo
echo ">>> regen-addon --check"
node "$here/regen-addon.mjs" --check || fail=1

shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
# The GDScript compilation floor: the real headless editor, wherever a godot
# binary exists (it reports SKIP without one).
echo
echo ">>> prove-addon-compiles.sh"
__t=$SECONDS; bash "$here/prove-addon-compiles.sh" || fail=1; prover_mark "$here/prove-addon-compiles.sh" "$__t"
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL VULCAN PROOFS PASS"; else echo "# ❌ SOME VULCAN PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
