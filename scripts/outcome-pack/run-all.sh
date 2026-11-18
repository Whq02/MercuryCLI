#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/runner/wire/methods.ts src/tools/BashTool/BashTool.tsx src/tasks/LocalShellTask/LocalShellTask.tsx src/utils/ShellCommand.ts
# gate-watch: src/daemon/protocol.ts
# gate-env: MERCURY_BUILD_OUTDIR
set -euo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/proof-runner.sh"
cd "$(dirname "$0")/../.."
out="${MERCURY_BUILD_OUTDIR:-$PWD/dist}"; case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
run_proof scripts/outcome-pack/prove-outcome-pack.ts bun run scripts/outcome-pack/prove-outcome-pack.ts --dist "$out/mercury.mjs" "$@"
