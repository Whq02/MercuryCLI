#!/usr/bin/env bash
# gate-class: pure
# gate-env: MERCURY_PROOF_POISON_GUARD MERCURY_PYTHON
# gate-watch: scripts/run-all-suites.sh scripts/run-drives.sh scripts/typecheck/fingerprint.sed
# gate-watch: scripts/typecheck/prove-warm-replay.sh scripts/typecheck/run-all.sh
# gate-watch: .github/workflows/gate.yml .github/workflows/drives.yml scripts/*/run-all.sh scripts/*/members.txt
# gate-watch: scripts/lib/** scripts/ui/vshot.py
# gate-watch: src/daemon/controlSocket.ts src/daemon/controlServer.ts
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: bunfig.toml
# gate-watch: src/tools/BashTool/pathValidation.ts src/tools/BashTool/readOnlyValidation.ts
# gate-watch: src/tools/PowerShellTool/readOnlyValidation.ts src/utils/bash/ast.ts src/utils/bash/specs/pyright.ts
# gate-watch: src/utils/shell/readOnlyCommandValidation.ts
# gate-watch: src/utils/permissions/flowLaw.ts src/utils/permissions/runtimeProtection.ts
# gate-watch: src/utils/wards/wardsRefusals.ts src/utils/wards/wardsShellRead.ts
# gate-watch: scripts/verify/fast.ts scripts/verify/impact.ts scripts/verify/impactManifest.ts scripts/verify/sliceCore.ts
# gate-watch: scripts/verify/prove-impact-manifest.ts scripts/verify/prove-impact-run.ts scripts/verify/prove-slice-core.ts
# gate-watch: scripts/substrate/prove-flag-registry-readers.ts scripts/substrate/prove-flag-registry-split.ts
# gate-watch: src/tasks/LocalShellTask/killShellTasks.ts src/tasks/LocalShellTask/LocalShellTask.tsx src/tools/BashTool/bashPermissions.ts src/tools/BashTool/BashTool.tsx
# gate-watch: src/tools/BashTool/BashToolResultMessage.tsx src/tools/BashTool/UI.tsx src/tools/BashTool/utils.ts src/tools/PowerShellTool/PowerShellTool.tsx
# gate-watch: src/tools/PowerShellTool/UI.tsx src/utils/bash/registry.ts src/utils/permissions/commandContent.ts src/utils/permissions/decision/commandAnalysis.ts
# gate-watch: src/utils/permissions/decision/rules.ts src/utils/permissions/permissionSetup.ts src/utils/permissions/ruleReason.ts src/utils/permissions/shellProtectedPaths.ts
# gate-watch: src/utils/permissions/shellRuleMatching.ts src/utils/Shell.ts src/utils/ShellCommand.ts
# gate-watch: src/cli/run.ts src/main.tsx
# gate-watch: src/utils/bash/ShellSnapshot.ts src/utils/bash/shellCompletion.ts src/utils/shell/shellRecord.ts
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
. "$(dirname "$0")/../lib/proof-runner.sh"
here="$(cd "$(dirname "$0")" && pwd)"
cd "$(dirname "$0")/../.." || exit 1
fail=0
echo "############################################################"
echo "# Gate machinery"
echo "############################################################"
drive_members gate 'scripts/gate/$name' "$here/members.txt" || fail=1
run_proof "$here/prove-source-text-reads.ts" "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-source-text-reads.ts" || true
run_proof "$here/prove-source-patterns.ts" "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-source-patterns.ts" || true
run_proof "$here/prove-unit-size.ts" "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-unit-size.ts" || true
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ GATE MACHINERY PASS"; else echo "# ❌ GATE MACHINERY FAILED"; fi
echo "############################################################"
exit "$fail"
