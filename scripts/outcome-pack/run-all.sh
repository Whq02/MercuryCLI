#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/daemon/runner-wire/methods.ts src/tools/shell/BashTool.tsx src/engine/tasks/local-shell/shellTask.tsx src/platform/shell/shellProcess.ts
# gate-watch: src/daemon/control/protocol.ts
# gate-env: MERCURY_BUILD_OUTDIR
set -euo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
cd "$(dirname "$0")/../.."
here="scripts/outcome-pack"
out="${MERCURY_BUILD_OUTDIR:-$PWD/dist}"; case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
drive_members outcome-pack 'scripts/outcome-pack/$name' "$here/members.txt" '' run || exit "$drive_member_code"
