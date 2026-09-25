#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/tools/ComputerTool/** src/services/desktop/** src/components/permissions/ComputerPermissionRequest/** src/components/PromptInput/PromptInputFooterLeftSide* src/utils/readiness* src/substrate/flagRegistry*
# gate-watch: src/utils/sessionStorage/writer* src/services/providers/anthropic/media* src/services/providers/anthropic/streamCore* src/services/providers/openai/responsesBridge* src/services/providers/openai/openaiCallModel*
# gate-watch: src/services/providers/zai/zaiCodec* src/utils/model/capabilities* src/tools/AgentTool/agentToolUtils* src/entrypoints/mcp* src/tools.ts scripts/computer/**
# gate-watch: native/desktop/src/mac.rs scripts/builtin-tools/fixtures/tool-census.json
# gate-watch: scripts/builtin-tools/fixtures/tool-census.md scripts/core-runtime/prove-state-contract.ts
# gate-watch: scripts/gate/duration-seed.tsv scripts/lib/hermetic.ts src/Tool.ts src/bootstrap/state.ts
# gate-watch: src/constants/tools.ts src/services/compact/compact.ts
# gate-watch: src/services/engine-connector/focusedConnector.ts src/services/primitives/executionCensus.ts
# gate-watch: src/services/providers/callModelRouter.ts
# gate-watch: src/services/providers/huggingface/huggingfaceCatalogue.ts
# gate-watch: src/services/providers/local/localDiscovery.ts
# gate-watch: src/services/providers/openaicompat/compatChatCallModel.ts
# gate-watch: src/services/providers/openrouter/openrouterCatalogue.ts src/services/providers/routeLaw.ts
# gate-watch: src/services/providers/zai/zaiCallModel.ts src/services/run/resolveOwner.ts
# gate-watch: src/state/AppStateStore.ts src/substrate/pidLock.ts src/substrate/startupMenu.ts
# gate-watch: src/tools/AgentTool/runAgent.ts src/tools/FileReadTool/imageProcessorJs.ts src/utils/*
# gate-watch: src/utils/capability/census.ts src/utils/capability/contract.ts src/utils/config/globalConfig.ts
# gate-watch: src/utils/permissions/decision/engine.ts src/utils/permissions/shellRuleMatching.ts
# gate-watch: src/utils/sessionStorage/chain.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
here="$(pwd)/scripts/computer"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
export MERCURY_CREDENTIAL_STORE="${MERCURY_CREDENTIAL_STORE:-file}"
echo "############################################################"
echo "# computer — the Computer tool's proofs"
echo "############################################################"
shopt -s nullglob
claimed=$(cat scripts/computer-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')

for proof in "$here"/prove-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")"; then continue; fi
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL COMPUTER PROOFS PASS"; else echo "# ❌ SOME COMPUTER PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
