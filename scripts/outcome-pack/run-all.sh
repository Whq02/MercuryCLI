#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/runner/wire/methods.ts src/tools/BashTool/BashTool.tsx src/tasks/LocalShellTask/LocalShellTask.tsx src/utils/ShellCommand.ts
# gate-watch: src/daemon/protocol.ts
# gate-env: MERCURY_BUILD_OUTDIR
set -euo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
cd "$(dirname "$0")/../.."
here="scripts/outcome-pack"
out="${MERCURY_BUILD_OUTDIR:-$PWD/dist}"; case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
drive_members outcome-pack 'scripts/outcome-pack/$name' "$here/members.txt" '' run || exit "$drive_member_code"
