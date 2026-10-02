#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/memdir/**
# gate-watch: src/utils/evolution/evolutionLedger* src/utils/evolution/ledgerScan*
# gate-watch: src/components/memory/MemoryCentreView.tsx src/services/compact/compact.ts
# gate-watch: src/services/eval/evalBridge.ts src/services/instructions/engine.ts src/services/instructions/sourceText.ts
# gate-watch: src/tools.ts src/tools/MemoryTools/MemoryTools.ts src/utils/attachments/memorySurfacing.ts
# gate-watch: src/utils/attachments/orchestrator.ts src/constants/prompts.ts src/constants/subagentDoctrine.ts
# gate-watch: src/utils/statusNoticeDefinitions.tsx src/substrate/flagRegistry.ts src/substrate/startupMenu.ts
# gate-watch: src/services/mcp/coordinationServer.ts src/utils/capability/declarations.ts src/query/stopHooks.ts
# gate-watch: src/commands.ts src/utils/memory/types.ts src/tools/AgentTool/agentMemory.ts
# gate-watch: src/utils/config/globalConfig.ts scripts/lib/settingsPopupHarness.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Memory — proof harness"
echo "############################################################"
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; __rc=0; "$bun" run "$f" || { __rc=$?; fail=1; }; prover_mark "$f" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL MEMORY PROOFS PASS"; else echo "# ❌ SOME MEMORY PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
