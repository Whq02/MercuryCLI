#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/**
# gate-watch: scripts/lib/* src/QueryEngine.ts src/cli/print.ts src/commands/model/mercuryModel.tsx
# gate-watch: src/commands/submodels/submodels.tsx src/components/* src/components/PromptInput/PromptInput.tsx
# gate-watch: src/components/Settings/Usage.tsx src/components/agents/studio/StudioEditor.tsx
# gate-watch: src/components/mercury-ui/EffortStrip.tsx src/constants/betas.ts src/constants/prompts.ts
# gate-watch: src/daemon/crewSpawn.ts src/ink.ts src/memdir/findRelevantMemories.ts
# gate-watch: src/services/concourse/coordinatorModels.ts src/services/concourse/workerModels.ts
# gate-watch: src/services/providers/* src/services/providers/anthropic/*
# gate-watch: src/services/providers/gemini/geminiCatalogue.ts src/services/providers/local/localCatalogue.ts
# gate-watch: src/services/providers/local/localDiscovery.ts src/services/providers/openai/*
# gate-watch: src/services/providers/openaicompat/compatWire.ts
# gate-watch: src/services/providers/openrouter/openrouterAccounts.ts
# gate-watch: src/services/providers/openrouter/openrouterCatalogue.ts src/services/providers/zai/glmPins.ts
# gate-watch: src/services/providers/zai/zaiCodec.ts src/skills/bundled/provider-apis/references/models.md
# gate-watch: src/state/AppState.tsx src/state/store.ts src/tools/AgentTool/agentToolUtils.ts
# gate-watch: src/tools/AgentTool/runAgent.ts src/tools/WorkflowTool/workflowRouting.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
[ -x "$BUN" ] || BUN="bun"
fail=0
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-no-speculative-catalog.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-no-speculative-catalog.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-model-truth.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-model-truth.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-usage-truth.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-usage-truth.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-submodels.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-submodels.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-submodel-effort-dial.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-submodel-effort-dial.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-model-honesty.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-model-honesty.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-spelling-fold.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-spelling-fold.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-frontier-wire-laws.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-frontier-wire-laws.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-opus-55-row.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-opus-55-row.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-picker-one-row-per-model.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-picker-one-row-per-model.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-canonical-fold.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-canonical-fold.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-picker-live-rows.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-picker-live-rows.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-family-defaults.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-family-defaults.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-picker-current-mark.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-picker-current-mark.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/model-registry/prove-picker-anthropic-section.ts || { __rc=$?; fail=1; }; prover_mark scripts/model-registry/prove-picker-anthropic-section.ts "$__t" "$__rc"
exit "$fail"
