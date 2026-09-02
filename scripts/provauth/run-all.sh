#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/providers/openrouter/** src/services/providers/gemini/**
# gate-watch: src/utils/router/providerSecrets* src/utils/router/providerDiscovery* src/utils/router/providers/**
# gate-watch: src/services/wallet/** src/services/providers/accountSlots* src/services/providers/providerUsage*
# gate-watch: src/services/claudeAiLimits* src/services/api/usage* src/services/providers/providerUsability*
# PROVAUTH — the provider AUTH suite: OpenRouter PKCE
# connect · OpenRouter live catalogue + key usage · Gemini key ladder +
# Google OAuth · Gemini live catalogue · wallet//accounts/usage-facade
# surfaces. Fixture rigs only — every endpoint base pinned to a
# non-resolvable host; no real provider is ever touched (live verification
# belongs to the billable window). New proofs are picked up by the glob;
# the pooled green gate
# (scripts/run-all-suites.sh) picks THIS suite up by ITS glob.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
# SUITE-LEVEL ISOLATION (the party-suite lesson): a gate run must never seed
# live operator stores with fixture rows; every prover additionally scopes
# itself to a mkdtemp MERCURY_CONFIG_DIR.
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
