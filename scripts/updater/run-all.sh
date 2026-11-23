#!/usr/bin/env bash
# gate-class: cpu
# gate-env: MERCURY_UPDATER_NETWORK MERCURY_JOURNEY_DIST MERCURY_BRIDGE_CANDIDATE MERCURY_BRIDGE_SLUG MERCURY_BRIDGE_PREVIOUS MERCURY_BRIDGE_PREVIOUS_TAG
# gate-watch: scripts/release/**
# gate-watch: src/screen/renderer/termio/alternateScrollPolicy.ts src/screen/renderer/termio/ansi.ts src/screen/renderer/termio/csi.ts src/screen/renderer/termio/dec.ts src/screen/renderer/termio/display-types.ts src/screen/renderer/termio/displayParser.ts src/screen/renderer/termio/notifyPing.ts src/screen/renderer/termio/osc.ts
# gate-watch: CONTRIBUTING.md
# gate-watch: scripts/lib/captureDriver.ts
# gate-watch: src/daemon/process-sweep/processSweep.ts src/daemon/process-sweep/processSweepRun.ts src/daemon/process-sweep/processSweepPosix.ts src/daemon/process-sweep/processSweepWindows.ts
# gate-watch: src/daemon/runner-link/headlessRun.ts src/integrations/acp/childSession.ts src/models/hosting/jobs.ts src/tools/engines/project-services/serviceManager.ts
# gate-watch: src/commands/feedback/BugReport.tsx docs/README.md docs/NIX.md nix/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
. "$(dirname "$0")/../lib/proof-runner.sh"
cd "$(dirname "$0")/../.." || exit 1
here="scripts/updater"
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "── RELEASE CHANNEL — updater/installer proofs ──"
drive_members updater 'scripts/updater/$name' "$here/members.txt" || fail=1

if [[ "${MERCURY_UPDATER_NETWORK:-}" == "1" ]]; then
  echo ""
  echo "▶ prove-release-bridge (network lane)"
  run_proof "$here/prove-release-bridge.ts" "$BUN" run "$here/prove-release-bridge.ts" || fail=1
else
  echo ""
  echo "· prove-release-bridge SKIPPED (network lane — MERCURY_UPDATER_NETWORK=1 opts in; the release workflow's bridge-gate always runs it)"
fi

if [[ "$fail" == "0" ]]; then
  echo ""
  echo "✅ updater suite pass"
  exit 0
fi
echo ""
echo "❌ updater suite FAILED"
exit 1
