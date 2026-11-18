#!/usr/bin/env bash
# gate-class: cpu
# gate-env: MERCURY_UPDATER_NETWORK MERCURY_JOURNEY_DIST MERCURY_BRIDGE_CANDIDATE MERCURY_BRIDGE_SLUG MERCURY_BRIDGE_PREVIOUS MERCURY_BRIDGE_PREVIOUS_TAG
# gate-watch: scripts/release/**
# gate-watch: src/ink/termio/*
# gate-watch: CONTRIBUTING.md
# gate-watch: scripts/lib/captureDriver.ts
# gate-watch: src/daemon/processSweep.ts src/daemon/processSweepRun.ts src/daemon/processSweepPosix.ts src/daemon/processSweepWindows.ts
# gate-watch: src/daemon/headlessRun.ts src/services/acp/childSession.ts src/services/host/jobs.ts src/services/projectServices/serviceManager.ts
# gate-watch: src/components/Feedback.tsx docs/README.md docs/NIX.md nix/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/proof-runner.sh"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root" || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0

claimed=$(cat scripts/updater-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')

echo "── RELEASE CHANNEL — updater/installer proofs ──"
for prover in prove-nix-ownership prove-nix-profile prove-nix-wrapper prove-current-release-words prove-channel-core prove-update-channel-rule prove-update-notice-newer prove-update-notice-stay prove-cleanup-keeps-verdict prove-status-check-agreement prove-update-provenance prove-update-remedy prove-update-installer-road prove-update-source-checkout prove-install-layout prove-update-cleanup-eperm prove-update-prune-live-version prove-install-path prove-version-contract prove-release-workflow prove-never-public prove-splash-ship prove-gitbash-resolution prove-update-journey prove-anonymous-channel prove-artifact-signing prove-verifier-bundle prove-signing-surfaces prove-payload-untouched-by-ripgrep-repair prove-shim-pointer-containment prove-windows-faithful-entries prove-windows-script-policy prove-launcher-reset-owner prove-verify-receipt-bind prove-node-pack prove-python-pack prove-release-targets prove-gh-timeout-live prove-update-plain-command; do
  if printf '%s\n' "$claimed" | grep -qx "$prover.ts"; then
    echo ""
    echo "· $prover runs with the updater drives (scripts/updater-drives/members.txt)"
    continue
  fi
  echo ""
  echo "▶ $prover"
  run_proof "$here/$prover.ts" "$BUN" run "$here/$prover.ts" || fail=1
done

echo ""
echo "▶ prove-archive-journey (archive lane — runs when release-out/ holds the host archive)"
run_proof "$here/prove-archive-journey.ts" "$BUN" run "$here/prove-archive-journey.ts" || fail=1

echo ""
echo "▶ prove-cross-archive-rosetta (archive lane — runs when release-out/ holds the macos-x64 archive on a Mac with Rosetta)"
run_proof "$here/prove-cross-archive-rosetta.ts" "$BUN" run "$here/prove-cross-archive-rosetta.ts" || fail=1

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
