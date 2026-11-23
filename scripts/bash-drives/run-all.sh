#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_SHELL_ENGINE
# gate-watch: src/permissions/rules/shell-commands/destructiveCommandWarning.ts src/permissions/rules/shell-commands/readOnlyCommandValidation.ts src/permissions/rules/shell-commands/sedValidation.ts src/permissions/rules/shell-commands/specPrefix.ts src/platform/shell/bashPack.ts src/platform/shell/bashProvider.ts src/platform/shell/brushPack.ts src/platform/shell/engineSession.ts src/platform/shell/globPreamble.ts src/platform/shell/msysArgv.ts src/platform/shell/outputFilter.ts src/platform/shell/outputLimits.ts src/platform/shell/parentGuard.ts src/platform/shell/powershellDetection.ts src/platform/shell/powershellProvider.ts src/platform/shell/resolveDefaultShell.ts src/platform/shell/shellEngineArm.ts src/platform/shell/shellOutput.ts src/platform/shell/shellProvider.ts src/platform/shell/shellRecord.ts src/platform/shell/windowsBatchInvocation.ts src/platform/shell/windowsBatchLine.ts src/platform/shell/windowsShellRoad.ts src/tools/kit/shellTools.ts build.ts
# gate-watch: src/daemon/control/ownedDaemon.ts
# gate-watch: scripts/lib/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/bash-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'bash-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members bash-drives 'scripts/bash/$name' "$here/members.txt"
