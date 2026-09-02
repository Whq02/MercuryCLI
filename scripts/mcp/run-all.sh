#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/bootstrap/state* src/services/mcp/** src/state/AppState* src/utils/Shell*
# gate-watch: src/utils/config/** src/utils/mcp/elicitationValidation*
# MCP hardening — proof harness (spec rev 2025-11-25 exercise; W6).
# Runs every scripts/mcp/prove-*.ts via bun run; non-zero exit on any failure.
# New proofs are picked up by the glob; '_'-prefixed files are helpers.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# MCP hardening — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL MCP PROOFS PASS"; else echo "# ❌ SOME MCP PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
