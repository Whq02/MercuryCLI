#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/providers/openrouter/** src/services/providers/gemini/**
# gate-watch: src/services/providers/providerSecrets.ts src/services/providers/providerDiscovery.ts src/services/providers/**
# gate-watch: src/services/wallet/** src/services/providers/accountSlots* src/services/providers/providerUsage*
# gate-watch: src/services/anthropicLimits* src/services/api/usage* src/services/providers/providerUsability*
# gate-watch: src/bootstrap/state.ts src/cli/run.ts src/commands/effectiveCatalogue.ts
# gate-watch: src/commands/logout/logout.tsx src/components/*
# gate-watch: src/components/Settings/Config.tsx src/components/Settings/Usage.tsx src/daemon/saturnAccount.ts
# gate-watch: src/components/Settings/usageLine.ts src/hooks/useDisplayedSessionModel.ts src/services/providers/zai/zaiCodec.ts
# gate-watch: src/daemon/saturnTicker.ts src/extensions/sources.ts src/ink.ts src/services/api/*
# gate-watch: src/services/oauth/client.ts src/services/providers/*
# gate-watch: src/services/providers/deepseek/deepseekUsageState.ts src/services/providers/huggingface/*
# gate-watch: src/services/providers/moonshot/* src/services/providers/openai/* src/services/providers/meta/**
# gate-watch: src/services/providers/openaicompat/compatChatCallModel.ts src/services/search/brave.ts
# gate-watch: src/services/search/tavily.ts src/utils/* src/utils/accounts/signInLedger.ts
# gate-watch: src/utils/cockpit/quota.ts src/utils/model/* src/utils/accounts/signInRefusal.ts src/daemon/signInView.ts
# gate-watch: src/utils/cockpit/helmVitalsModel.ts src/Tool.ts src/utils/crew/engineDispatch.ts src/state/AppState.tsx
# gate-watch: src/services/engine-connector/daemonConnector.ts src/services/engine-connector/types.ts src/daemon/sessionSeat.ts
# gate-watch: src/services/providers/openai/openaiAccounts.ts src/services/providers/openai/openaiCatalogue.ts src/utils/effort.ts src/services/engine-connector/seatProjections.ts
# gate-watch: src/tools/ToolSearchTool/prompt.ts
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
