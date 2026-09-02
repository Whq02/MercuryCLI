#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/providers/openrouter/** src/services/providers/gemini/**
# gate-watch: src/utils/router/providerSecrets* src/utils/router/providerDiscovery* src/utils/router/providers/**
# gate-watch: src/services/wallet/** src/services/providers/accountSlots* src/services/providers/providerUsage*
# gate-watch: src/services/claudeAiLimits* src/services/api/usage* src/services/providers/providerUsability*
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
export MERCURY_EVOLUTION_LEDGER=0
echo "############################################################"
echo "# PROVAUTH — provider auth proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo ""
  __t=$SECONDS; if ! "$bun" run "$proof"; then
    fail=$((fail + 1))
  fi
  prover_mark "$proof" "$__t"
done
echo ""
if [ "$fail" -gt 0 ]; then
  echo "❌ provauth suite: $fail prover(s) red"
  exit 1
fi
echo "✅ provauth suite green"
