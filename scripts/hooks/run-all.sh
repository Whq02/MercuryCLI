#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/hooks/**
# gate-watch: src/bootstrap/state.ts src/cli/run.ts src/schemas/hooks.ts src/utils/config/trust.ts
# gate-watch: src/components/hooks/** src/components/messages/AttachmentMessage.tsx
# gate-watch: src/fabric/entryCodec.ts src/hooks/useSkillsChange.ts src/utils/*
# gate-watch: src/utils/config/globalConfig.ts src/utils/sessionStorage/chain.ts
# gate-watch: src/utils/sessionStorage/paths.ts src/utils/settings/settingsCache.ts
# gate-watch: scripts/lib/fixtureApi.ts src/rows/turn.ts src/Tool.ts src/query.ts src/run-core/**
# gate-watch: src/utils/hooks/contract.ts src/skills/bundled/updateConfig.ts src/utils/hooks/hooksConfigManager.ts
# gate-watch: src/utils/messages/turnCut.ts src/utils/settings/settings.ts src/utils/settings/types.ts
# gate-watch: src/services/tools/toolHooks.ts src/services/tools/toolExecution.ts src/guards/** src/daemon/sessionStateHooks.ts
# gate-watch: src/query/stopHooks.ts src/utils/processUserInput/processUserInput.ts src/utils/sessionStart.ts src/utils/gracefulShutdown.ts
# gate-watch: src/rows/vocabulary.ts src/rows/project.ts docs/HOOKS.md sdk/src/rows.ts
# gate-watch: src/cli/headless/resume.ts src/utils/model/model.ts src/utils/sessionStorage/vnext.ts
# gate-watch: src/utils/sessionStorage/rowGraph.ts src/utils/sessionStorage/transcriptReader.ts src/utils/conversationRecovery.ts
# gate-watch: src/components/Messages.tsx src/ink.ts src/state/AppState.tsx src/state/AppStateStore.ts src/tools.ts
# gate-watch: src/utils/shell/powershellDetection.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── hooks proofs ──"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-hook-event-table.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-hook-event-table.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-hook-matching.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-hook-matching.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-hook-detail-fields.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-hook-detail-fields.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-hook-endings.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-hook-endings.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-hook-command-runner.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-hook-command-runner.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-hook-fire.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-hook-fire.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-hook-session-state.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-hook-session-state.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-session-start-model.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-session-start-model.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-hook-tool-road.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-hook-tool-road.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-hook-turn-road.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-hook-turn-road.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-hook-cut.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-hook-cut.ts" "$__t" "$__rc"
if [[ "$fail" == "0" ]]; then echo "✅ HOOKS SUITE GREEN"; exit 0; else
  echo "❌ HOOKS SUITE RED"; exit 1; fi
