#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/dap/dapClient* src/services/run/ownerKey*
# gate-watch: src/services/run/ownerLifecycle* src/tools/DebugTool/DebugTool*
# gate-watch: src/services/lsp/clangdLane* src/services/lsp/mercuryLsp*
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# dap — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL DAP PROOFS PASS"; else echo "# ❌ SOME DAP PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
