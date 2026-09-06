#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/permissions/shellRuleMatching* src/utils/shell/globPreamble*
# gate-watch: src/utils/shell/readOnlyCommandValidation*
# gate-watch: src/utils/ShellCommand.ts src/tasks/LocalShellTask/* src/tools/BashTool/BashTool.tsx
# gate-watch: src/utils/processGroup.ts src/tools/TaskStopTool/* src/tasks/stopTask.ts src/Task.ts
# gate-watch: src/utils/task/TaskOutput.ts src/utils/hooks/AsyncHookRegistry.ts src/tools/MonitorTool/*
# gate-watch: src/tools/AgentTool/runAgent.ts src/daemon/headlessRun.ts src/utils/fileHistory.ts
# gate-watch: src/utils/secureStorage/macOsKeychainStorage.ts src/tasks/LocalWorkflowTask/*
# gate-watch: src/services/workshop/pythonRuntime.ts src/services/workshop/pythonRunnerSource.ts
# gate-watch: src/services/tcpBridge/entry.ts src/services/ide/cppBuild.ts src/services/mcp/headersHelper.ts
# gate-watch: src/utils/worktree.ts src/utils/projectStoreAdoption.ts
# gate-watch: src/utils/bash/ShellSnapshot.ts src/utils/shell/engineSession.ts src/utils/shell/brushPack.ts
# gate-watch: src/services/lsp/LSPClient.ts src/services/dap/dapClient.ts
# gate-watch: src/utils/bash/bashPipeCommand* src/utils/bash/shellQuoting* src/utils/shell/bashProvider* src/utils/sandbox/sandbox-adapter*
# gate-watch: src/utils/bash/bashPipeCommand* src/utils/bash/shellQuoting* src/utils/shell/bashProvider* src/utils/shell/shellProvider*
# gate-watch: src/tools/BashTool/bashPermissions* src/tools/BashTool/readOnlyValidation* src/tools/BashTool/shouldUseSandbox* src/tools/BashTool/prompt*
# gate-watch: src/utils/sandbox/sandbox-adapter* src/substrate/flagRegistry* scripts/bash/shell-engine-parity*
# gate-watch: src/utils/shell/windowsShellRoad.ts src/utils/windowsPaths.ts src/utils/shell/shellToolUtils.ts
# gate-watch: .github/workflows/shell-windows-probe.yml .github/workflows/private-release.yml
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Bash permission & security — proof harness"
echo "############################################################"
__t=$SECONDS; "$bun" run "$here/prove-bash-permissions.ts" || fail=1; prover_mark "$here/prove-bash-permissions.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-glob-preamble.ts" || fail=1; prover_mark "$here/prove-glob-preamble.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-shell-settlement.ts" || fail=1; prover_mark "$here/prove-shell-settlement.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-stop-ends-the-tree.ts" || fail=1; prover_mark "$here/prove-stop-ends-the-tree.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-task-outcome-envelope.ts" || fail=1; prover_mark "$here/prove-task-outcome-envelope.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-scratch-leases.ts" || fail=1; prover_mark "$here/prove-scratch-leases.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-baseline-worktree.ts" || fail=1; prover_mark "$here/prove-baseline-worktree.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-output-tail-truth.ts" || fail=1; prover_mark "$here/prove-output-tail-truth.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-worktree-janitor.ts" || fail=1; prover_mark "$here/prove-worktree-janitor.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-resolved-invocation.ts" || fail=1; prover_mark "$here/prove-resolved-invocation.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-win32-console-close-cleanup.ts" || fail=1; prover_mark "$here/prove-win32-console-close-cleanup.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-watch-root-census.ts" || fail=1; prover_mark "$here/prove-watch-root-census.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-shell-snapshot-path.ts" || fail=1; prover_mark "$here/prove-shell-snapshot-path.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-teardown-ends-the-tree.ts" || fail=1; prover_mark "$here/prove-teardown-ends-the-tree.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-shell-cwd-record.ts" || fail=1; prover_mark "$here/prove-shell-cwd-record.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-bash-tool-seams.ts" || fail=1; prover_mark "$here/prove-bash-tool-seams.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-shell-engine-pack.ts" || fail=1; prover_mark "$here/prove-shell-engine-pack.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-shell-engine-session.ts" || fail=1; prover_mark "$here/prove-shell-engine-session.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-shell-engine-exec.ts" || fail=1; prover_mark "$here/prove-shell-engine-exec.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-shell-engine-rules.ts" || fail=1; prover_mark "$here/prove-shell-engine-rules.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-shell-engine-sandbox.ts" || fail=1; prover_mark "$here/prove-shell-engine-sandbox.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-shell-engine-census.ts" || fail=1; prover_mark "$here/prove-shell-engine-census.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-shell-engine-parity.ts" || fail=1; prover_mark "$here/prove-shell-engine-parity.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-windows-shell-road.ts" || fail=1; prover_mark "$here/prove-windows-shell-road.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-shell-windows-pack-layout.ts" || fail=1; prover_mark "$here/prove-shell-windows-pack-layout.ts" "$__t"
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL BASH PERMISSION PROOFS PASS"; else echo "# ❌ SOME BASH PERMISSION PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
