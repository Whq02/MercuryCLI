#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/providers/busyRetry.ts src/services/providers/temporaryStreamError.ts src/services/providers/openai/** src/services/providers/xai/xaiResponsesTransport.ts src/services/providers/openrouter/openrouterResponsesTransport.ts
# gate-watch: src/services/providers/routeLaw* src/services/providers/openaicompat/**
# gate-watch: src/services/providers/openrouter/** src/utils/settings/** scripts/lib/settingsPopupHarness.ts
# gate-watch: src/services/providers/moonshot/** src/services/providers/deepseek/**
# gate-watch: src/services/providers/huggingface/** src/services/providers/local/**
# gate-watch: src/services/providers/zai/glmPins* src/services/providers/**
# gate-watch: src/utils/model/modelOptions* src/utils/model/capabilities*
# gate-watch: src/utils/crew/engineDispatch.ts src/utils/config.ts src/utils/config/schema.ts src/types/message.ts src/services/resources/adapters/models.ts src/components/CompatConnect.tsx src/components/ConsoleOAuthFlow.tsx src/components/BootLoginsScreen.tsx src/components/loginFamilyRows.ts src/commands/login/login.tsx
# gate-watch: scripts/lib/hermetic.ts
# gate-watch: src/services/localServer/** src/utils/settings/types.ts scripts/settings/settings-schema.json
# gate-watch: scripts/lib/fixtureApi.ts scripts/local-setup/fixtures/fake-ollama.ts
# gate-watch: src/services/providers/emptyStreamRetry.ts src/services/providers/streamIdleBudget.ts src/services/api/recoveryBudget.ts src/components/Spinner/liveCounterWords.ts
# gate-watch: src/services/providers/anthropic/streamCore.ts src/services/providers/zai/zaiCallModel.ts src/services/providers/gemini/** src/services/providers/xai/** src/services/providers/meta/**
# gate-watch: src/services/providers/mistral/** scripts/providers/lib/mistral-fixture.ts
# gate-watch: src/services/providers/zen/** scripts/providers/lib/zen-fixture.ts src/services/providers/zen/zenAdapter.ts
# gate-watch: src/services/providers/groq/** src/services/providers/cerebras/** src/services/providers/fireworks/** scripts/providers/lib/fast-infer-control.ts
# gate-watch: scripts/tool-economy/fixtureMcpEstate.ts
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: scripts/providers/lib/nous-fixture.ts src/services/providers/nous/**
# gate-watch: scripts/providers/lib/openweights-fixture.ts src/services/providers/minimax/** src/services/providers/together/** src/services/providers/cohere/**
# gate-watch: scripts/compact/overflowFixture.ts src/services/api/outputFit.ts src/query/transitions.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# provider-compat — multi-provider proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
exit "$fail"
