#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/bootstrap/state* src/services/mcp/** src/state/AppState* src/utils/Shell*
# gate-watch: src/utils/config/** src/utils/mcp/elicitationValidation*
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# MCP hardening — proof harness"
echo "############################################################"
shopt -s nullglob
claimed=$(cat scripts/mcp-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')

for proof in "$here"/prove-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")"; then continue; fi
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL MCP PROOFS PASS"; else echo "# ❌ SOME MCP PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
