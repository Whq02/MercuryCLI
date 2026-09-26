#!/usr/bin/env bash
# gate-class: pure
# gate-env: MERCURY_PROOF_POISON_SCRUB MERCURY_SHELL_ENGINE MERCURY_TMPDIR
# gate-watch: src/utils/permissions/shellRuleMatching* src/utils/shell/globPreamble*
# gate-watch: src/utils/shell/readOnlyCommandValidation*
# gate-watch: src/utils/ShellCommand.ts src/tasks/LocalShellTask/* src/tools/BashTool/BashTool.tsx src/tools/BashTool/commandSemantics.ts
# gate-watch: src/utils/processGroup.ts src/tools/TaskStopTool/* src/tasks/stopTask.ts src/Task.ts
# gate-watch: src/utils/task/TaskOutput.ts src/utils/hooks/AsyncHookRegistry.ts src/tools/MonitorTool/*
# gate-watch: src/tools/AgentTool/runAgent.ts src/daemon/headlessRun.ts src/utils/fileHistory.ts
# gate-watch: src/utils/secureStorage/macOsKeychainStorage.ts src/tasks/LocalWorkflowTask/*
# gate-watch: src/services/workshop/pythonRuntime.ts src/services/workshop/pythonRunnerSource.ts
# gate-watch: src/services/tcpBridge/entry.ts src/services/ide/cppBuild.ts src/services/mcp/headersHelper.ts
# gate-watch: src/utils/collapseBackgroundBashNotifications*
# gate-watch: src/utils/worktree.ts src/utils/projectStoreAdoption.ts
# gate-watch: src/utils/bash/ShellSnapshot.ts src/utils/shell/engineSession.ts src/utils/shell/brushPack.ts
# gate-watch: src/services/lsp/LSPClient.ts src/services/dap/dapClient.ts
# gate-watch: src/utils/bash/bashPipeCommand* src/utils/bash/shellQuoting* src/utils/shell/bashProvider* src/utils/sandbox/sandbox-adapter*
# gate-watch: src/utils/bash/bashPipeCommand* src/utils/bash/shellQuoting* src/utils/shell/bashProvider* src/utils/shell/shellProvider*
# gate-watch: src/tools/BashTool/bashPermissions* src/tools/BashTool/readOnlyValidation* src/tools/BashTool/shouldUseSandbox* src/tools/BashTool/prompt*
# gate-watch: src/utils/sandbox/sandbox-adapter* src/substrate/flagRegistry* scripts/bash/shell-engine-parity*
# gate-watch: src/utils/shell/windowsShellRoad.ts src/utils/windowsPaths.ts src/utils/shell/shellToolUtils.ts
# gate-watch: .github/workflows/shell-windows-probe.yml .github/workflows/private-release.yml
# gate-watch: src/utils/Shell.ts src/substrate/envStamps.ts src/tools/shared/sessionEnvNotice.ts src/tools/PowerShellTool/PowerShellTool.tsx
# gate-watch: src/utils/toolErrors.ts src/utils/waitCeiling.ts src/tools/BashTool/utils.ts src/tools/BashTool/maxOutputChars.ts src/tools/PowerShellTool/prompt.ts
# gate-watch: src/Tool.ts src/bootstrap/state.ts src/cli/print.ts src/constants/subagentDoctrine.ts
# gate-watch: src/daemon/main.ts src/entrypoints/init.ts src/ink/components/App.tsx src/screens/REPL.tsx
# gate-watch: src/services/ide/cppProject.ts src/state/AppStateStore.ts src/tasks/taskOutcomeEnvelope.ts
# gate-watch: src/tools/WorkflowTool/WorkflowTool.tsx src/utils/* src/utils/bash/shellQuote.ts
# gate-watch: src/utils/bash/specs/** src/utils/hooks/execution.ts src/utils/permissions/**
# gate-watch: src/utils/processUserInput/processBashCommand.tsx src/utils/settings/types.ts src/utils/shell/*
# gate-watch: src/utils/task/diskOutput.ts vendor/brush.lock.json
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Bash permission & security — proof harness"
echo "############################################################"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-bash-permissions.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-bash-permissions.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-glob-preamble.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-glob-preamble.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-shell-split.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-shell-split.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-shell-settlement.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-shell-settlement.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-stop-ends-the-tree.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-stop-ends-the-tree.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-task-outcome-envelope.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-task-outcome-envelope.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-scratch-leases.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-scratch-leases.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-baseline-worktree.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-baseline-worktree.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-output-tail-truth.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-output-tail-truth.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-output-budget.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-output-budget.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-worktree-janitor.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-worktree-janitor.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-resolved-invocation.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-resolved-invocation.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-win32-console-close-cleanup.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-win32-console-close-cleanup.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-shell-providers-detach-alike.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-shell-providers-detach-alike.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-watch-root-census.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-watch-root-census.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-shell-snapshot-path.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-shell-snapshot-path.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-teardown-ends-the-tree.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-teardown-ends-the-tree.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-shell-cwd-record.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-shell-cwd-record.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-bash-tool-seams.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-bash-tool-seams.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-background-exit-code.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-background-exit-code.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-exit-code-words.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-exit-code-words.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-empty-command-refused.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-empty-command-refused.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-shell-record-of-sub-agent-launch.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-shell-record-of-sub-agent-launch.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-sub-agent-shell-notification.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-sub-agent-shell-notification.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-shell-session-env.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-shell-session-env.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-shell-engine-pack.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-shell-engine-pack.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-shell-engine-session.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-shell-engine-session.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-shell-engine-exec.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-shell-engine-exec.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-shell-engine-rules.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-shell-engine-rules.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-shell-engine-sandbox.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-shell-engine-sandbox.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-shell-engine-census.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-shell-engine-census.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-shell-engine-parity.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-shell-engine-parity.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-windows-shell-road.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-windows-shell-road.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-shell-windows-pack-layout.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-shell-windows-pack-layout.ts" "$__t" "$__rc"
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL BASH PERMISSION PROOFS PASS"; else echo "# ❌ SOME BASH PERMISSION PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
