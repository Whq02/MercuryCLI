#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/lib/scriptedTurn.ts scripts/lib/fixtureApi.ts scripts/lib/rows.ts scripts/lib/processGroup.ts scripts/lib/runnerHost.ts scripts/lib/seatForensics.ts scripts/lib/captureDriver.ts scripts/lib/suite-env.sh scripts/lib/process-ledger.sh scripts/lib/proofScratch.cjs scripts/lib/proofBrowser.cjs scripts/lib/firstRunSeed.ts scripts/daemon/dupline-world.ts
# gate-watch: src/utils/verification/verificationState.ts src/utils/sessionStorage/transcriptReader.ts src/runner/wire/methods.ts src/tools/BashTool/BashTool.tsx src/tasks/LocalShellTask/LocalShellTask.tsx src/utils/ShellCommand.ts
# gate-watch: src/daemon/controlSocket.ts src/daemon/protocol.ts
# gate-env: MERCURY_BUILD_OUTDIR
set -euo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
cd "$(dirname "$0")/../.."
bun run scripts/outcome-pack/prove-outcome-pack.ts --dist "${MERCURY_BUILD_OUTDIR:-dist}/mercury.mjs" "$@"
