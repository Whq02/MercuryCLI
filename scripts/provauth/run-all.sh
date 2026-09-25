#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/providers/openrouter/** src/services/providers/gemini/**
# gate-watch: src/utils/router/providerSecrets* src/utils/router/providerDiscovery* src/utils/router/providers/**
# gate-watch: src/services/wallet/** src/services/providers/accountSlots* src/services/providers/providerUsage*
# gate-watch: src/services/claudeAiLimits* src/services/api/usage* src/services/providers/providerUsability*
# gate-watch: src/bootstrap/state.ts src/cli/print.ts src/commands/effectiveCatalogue.ts
# gate-watch: src/commands/logout/logout.tsx src/commands/router/router.tsx src/components/*
# gate-watch: src/components/Settings/Config.tsx src/components/Settings/Usage.tsx src/daemon/saturnAccount.ts
# gate-watch: src/daemon/saturnTicker.ts src/extensions/sources.ts src/ink.ts src/services/api/*
# gate-watch: src/services/oauth/client.ts src/services/providers/*
# gate-watch: src/services/providers/deepseek/deepseekUsageState.ts src/services/providers/huggingface/*
# gate-watch: src/services/providers/moonshot/* src/services/providers/openai/*
# gate-watch: src/services/providers/openaicompat/compatChatCallModel.ts src/services/search/brave.ts
# gate-watch: src/services/search/tavily.ts src/utils/* src/utils/accounts/signInLedger.ts
# gate-watch: src/utils/cockpit/quota.ts src/utils/model/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

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
  __t=$SECONDS; __rc=0; if ! { "$bun" run "$proof"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    fail=$((fail + 1))
  fi
  prover_mark "$proof" "$__t" "$__rc"
done
echo ""
if [ "$fail" -gt 0 ]; then
  echo "❌ provauth suite: $fail prover(s) red"
  exit 1
fi
echo "✅ provauth suite green"
