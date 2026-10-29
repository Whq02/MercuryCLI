#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/attachments/prove-session-context-once.ts
# gate-watch: src/utils/attachments/**
# gate-watch: src/services/projectIntel/capsule.ts
# gate-watch: src/utils/pdf.ts src/utils/fsOperations.ts src/tools/FileReadTool/prompt.ts
# gate-watch: src/services/instructions/engine.ts src/utils/permissions/filesystem.ts src/utils/task/framework.ts
# gate-watch: src/services/lsp/LSPDiagnosticRegistry.ts src/services/lsp/manager.ts src/utils/tasks.ts src/tools/TaskUpdateTool/constants.ts src/tools/BashTool/toolName.ts src/utils/cwd.ts
# gate-watch: src/utils/imageResizer* src/utils/imagePaste* src/utils/imageStore* src/utils/imageValidation*
# gate-watch: src/constants/apiLimits* src/tools/FileReadTool/imageProcessor* src/hooks/usePasteHandler* src/hooks/useClipboardImageHint*
# gate-watch: docs/SESSIONS.md scripts/lib/goldenReplay.ts scripts/lib/hermetic.ts scripts/lib/scriptedTurn.ts scripts/daemon/dupline-world.ts src/Tool.ts
# gate-watch: src/bootstrap/state.ts src/constants/prompts.ts src/constants/systemPromptSections.ts
# gate-watch: src/keybindings/defaultBindings.ts src/services/mcp/client.ts src/utils/sessionStorage/writer.ts src/utils/sessionStorage/paths.ts src/utils/sessionStorage/chain.ts src/utils/sessionStorage/loading.ts src/utils/messages/factories.ts
# gate-watch: src/tools/FileReadTool/FileReadTool.ts src/utils/attachments.ts
# gate-watch: src/utils/messages/apiView.ts src/utils/attachments/orchestrator.ts src/context.ts src/utils/cockpit/runtimePosture.ts src/run-core/attachment-drain.ts src/tools/ToolSearchTool/ToolSearchTool.ts src/tools/WebFetchTool/WebFetchTool.ts
# gate-watch: src/utils/messages.ts src/utils/messages/attachmentText.ts src/utils/config/globalConfig.ts src/utils/model/model.ts src/tools/SkillTool/constants.ts src/state/AppStateStore.ts src/utils/file.ts src/utils/fileStateCache.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── context-assembly proofs ──"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-attachments-parity.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-attachments-parity.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-mention-grammar.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-mention-grammar.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-mention-resolution.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-mention-resolution.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-producer-gates.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-producer-gates.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-phase-delivery.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-phase-delivery.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-capsule-ledgers.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-capsule-ledgers.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-nested-memory-admission.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-nested-memory-admission.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-pasted-image-blocks.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-pasted-image-blocks.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-async-hook-delivery.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-async-hook-delivery.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-read-cache-bounds.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-read-cache-bounds.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-file-change-observation.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-file-change-observation.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-file-admission.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-file-admission.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-capsule-receipts.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-capsule-receipts.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-capsule-facts.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-capsule-facts.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-capsule-request.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-capsule-request.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-capsule-turn.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-capsule-turn.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-image-road.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-image-road.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-tool-result-image-note.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-tool-result-image-note.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-stored-image-assembly.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-stored-image-assembly.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-session-context-once.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-session-context-once.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-turn-attachment-roster.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-turn-attachment-roster.ts" "$__t" "$__rc"
if [[ "$fail" == "0" ]]; then echo "✅ ATTACHMENTS SUITE GREEN"; exit 0; else
  echo "❌ ATTACHMENTS SUITE RED"; exit 1; fi
