#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/dap/dapClient* src/services/lsp/** src/services/run/effectObserver*
# gate-watch: src/services/run/ownerKey* src/services/tcpBridge/entry* src/substrate/flagRegistry*
# gate-watch: src/tools/LSPTool/** src/utils/**
# gate-watch: src/services/diagnosticTracking.ts
# gate-watch: src/Tool.ts src/bootstrap/state.ts src/constants/subagentDoctrine.ts
# gate-watch: src/entrypoints/cli.tsx src/services/changeTransaction/changeSetCommit.ts
# gate-watch: src/services/changeTransaction/contracts.ts src/tools.ts src/tools/DebugTool/DebugTool.ts
# gate-watch: scripts/ast-tools/lib/harness.ts
# gate-watch: src/cli/lspVerb.ts src/main.tsx assets/completions/_mercury assets/completions/mercury.bash assets/completions/mercury.fish scripts/lib/hermetic.ts
# gate-watch: src/services/providers/toolEconomy.ts src/services/providers/toolCallGate.ts src/services/providers/anthropic/boundPrefixRecord.ts
# gate-watch: src/tools/AgentTool/agentToolUtils.ts src/tools/ToolSearchTool/** src/fabric/** src/tools/MCPTool/absentToolShim.ts
# gate-watch: build.ts
# gate-watch: src/tools/FileEditTool/FileEditTool.ts src/tools/FileWriteTool/FileWriteTool.ts src/tools/ChangeSetTool/ChangeSetTool.ts src/tools/AstEditTool/AstEditTool.ts
# gate-watch: README.md src/commands.ts src/commands/lsp/** src/components/HelpV2/commandDomains.ts src/services/structure/grammarRegistry.ts src/tools/DebugTool/prompt.ts vendor/grammars.lock.json
# gate-watch: src/query/stopHooks.ts src/run-core/turn-machine.ts src/services/run/resolveOwner.ts
# gate-watch: src/tools/AgentTool/runAgent.ts src/tools/BashTool/toolName.ts src/tools/FileReadTool/FileReadTool.ts
# gate-watch: docs/AUTOMATION.md
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; __rc=0; "$bun" run "$f" || { __rc=$?; fail=1; }; prover_mark "$f" "$__t" "$__rc"
done
exit $fail
