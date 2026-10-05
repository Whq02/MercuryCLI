#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/sessionStorage/** src/utils/sessionStoragePortable.ts src/history.ts src/rows/storage.ts
# gate-watch: scripts/engine-durability/harness.ts scripts/lib/codeText.ts scripts/lib/goldenReplay.ts
# gate-watch: scripts/staleness/prove-stale-registry.ts src/Tool.ts src/bootstrap/state.ts
# gate-watch: src/daemon/concourseWorkers.ts src/fabric/transcriptDecode.ts src/hooks/useHistorySearch.ts
# gate-watch: src/screens/Chat.tsx src/services/engine-connector/daemonConnector.ts
# gate-watch: src/services/switchboard/hopIntoSession.ts src/services/tools/toolExecution.ts src/utils/*
# gate-watch: src/utils/suggestions/shellHistoryCompletion.ts
# gate-watch: src/hooks/useArrowKeyHistory.tsx src/ink.ts src/state/AppState.tsx src/utils/config/globalConfig.ts
# gate-watch: scripts/lib/platformPath.ts
# gate-watch: src/utils/conversationRecovery.ts src/cli/headless/resume.ts
# gate-watch: src/utils/sessionClass.ts src/utils/messages/attachmentText.ts src/components/messages/nullRenderingAttachments.ts src/utils/sessionStorage/vnext.ts
# gate-watch: src/utils/attachments/types.ts src/keybindings/loadUserBindings.ts src/fabric/transcriptDecode.ts src/components/mercury-ui/toolGlyphs.ts src/daemon/crewSpawn.ts src/commands/crewmates/index.ts src/keybindings/actionGraph.ts src/keybindings/parser.ts src/main.tsx src/state/AppStateStore.ts src/substrate/operationJournal.ts src/tools/AgentTool/AgentTool.tsx src/utils/crew/crewConvert.ts src/utils/crew/constants.ts src/utils/crew/crewHelpers.ts src/utils/crew/crewOperations.ts src/utils/envUtils.ts src/utils/crewEnabled.ts src/utils/zodToJsonSchema.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── session-persistence proofs ──"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-sessionstorage-parity.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-sessionstorage-parity.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-resume-parity.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-resume-parity.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-storage-row-vocabulary.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-storage-row-vocabulary.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-indexed-fold.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-indexed-fold.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-snip-cycle.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-snip-cycle.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-meta-owner.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-meta-owner.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-project-key-canonical.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-project-key-canonical.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-project-home-fold.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-project-home-fold.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-project-key-stability.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-project-key-stability.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-project-recognition.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-project-recognition.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-history-flush-death.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-history-flush-death.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-first-prompt-extractor.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-first-prompt-extractor.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-writer-hardening.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-writer-hardening.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-record-branch-pruning.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-record-branch-pruning.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-field-e004-parallel-batch-resume.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-field-e004-parallel-batch-resume.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-torn-tail-heal.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-torn-tail-heal.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-store-not-cross-adopted.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-store-not-cross-adopted.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-concurrent-chain-fork.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-concurrent-chain-fork.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-decision-rows-thread.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-decision-rows-thread.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-insert-adversarial.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-insert-adversarial.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-discovery-scan-pool.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-discovery-scan-pool.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-listing-memo.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-listing-memo.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-history-read-economy.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-history-read-economy.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-history-walk-fresh.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-history-walk-fresh.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-cleared-mark-wired.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-cleared-mark-wired.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-store-failure-surfaces.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-store-failure-surfaces.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-transcript-degradation-stated.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-transcript-degradation-stated.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-transcript-tail-reader.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-transcript-tail-reader.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-old-transcript-kinds-parse.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-old-transcript-kinds-parse.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-transcript-consumers-owned.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-transcript-consumers-owned.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-drain-fault-isolation.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-drain-fault-isolation.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-resume-snapshot-honesty.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-resume-snapshot-honesty.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-flush-drain-ladder.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-flush-drain-ladder.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-session-model-entry.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-session-model-entry.ts" "$__t" "$__rc"
if [[ "$fail" == "0" ]]; then echo "✅ SESSIONSTORAGE SUITE GREEN"; exit 0; else
  echo "❌ SESSIONSTORAGE SUITE RED"; exit 1; fi
