#!/usr/bin/env bash
# gate-class: cpu
# gate-env: MERCURY_UPDATER_NETWORK MERCURY_JOURNEY_DIST MERCURY_BRIDGE_CANDIDATE MERCURY_BRIDGE_SLUG MERCURY_BRIDGE_PREVIOUS MERCURY_BRIDGE_PREVIOUS_TAG
# gate-watch: src/services/privateChannel/** src/cli/update.ts src/cli/installVerb.ts
# gate-watch: scripts/release/** .github/workflows/private-release.yml package.json src/constants/changelog.ts THIRD_PARTY_NOTICES.md
# gate-watch: assets/splash/mercury-splash.mjs src/utils/windowsPaths.ts
# gate-watch: scripts/lib/settingsPopupHarness.ts src/components/App.tsx src/components/BootSplashScreen.tsx src/components/SurfaceRouter.tsx src/screens/Chat.tsx src/state/AppState.tsx src/state/AppStateStore.ts
# gate-watch: src/keybindings/KeybindingProviderSetup.tsx src/context/surfaceRoute.ts src/hooks/useLayoutTier.ts src/utils/config.ts src/input-core/pending-input.ts src/services/engine-connector/focusedConnector.ts src/services/engine-connector/noSessionConnector.ts src/utils/daemonStanddown.ts
# gate-watch: assets/splash/splash-core.mjs docs/COMPATIBILITY.md docs/INSTALL-WINDOWS-FROM-SOURCE.md docs/TERMINAL-RUNTIME.md docs/releases/1.0.0-beta.3.md scripts/distribution/generate-third-party-notices.ts
# gate-watch: scripts/gate/gate-ledger.jsonl scripts/lib/proofHomePreload.ts scripts/ops/launcher-mercury.sh scripts/splash/run-all.sh scripts/vendor/build-desktop.ts scripts/vendor/build-voice.ts
# gate-watch: scripts/vendor/build-whisper.ts scripts/vendor/fetch-node.ts scripts/vendor/fetch-platform-packages.ts scripts/vendor/platformPackages.ts scripts/vscode/build-vsix.sh src/services/voice/voicePack.ts
# gate-watch: src/substrate/flagRegistry.ts src/tools/FileReadTool/imagePackArm.ts src/utils/auth.ts src/utils/envUtils.ts src/utils/healthReport.ts src/utils/runtime/nodePolicy.ts
# gate-watch: src/utils/shell/brushPack.ts vendor/brush.lock.json vendor/node.lock.json
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
for prover in prove-channel-core prove-update-notice-newer prove-update-notice-stay prove-cleanup-keeps-verdict prove-status-check-agreement prove-update-provenance prove-update-installer-road prove-update-source-checkout prove-install-layout prove-update-cleanup-eperm prove-install-path prove-version-contract prove-release-workflow prove-never-public prove-splash-ship prove-gitbash-resolution prove-update-journey prove-anonymous-channel prove-artifact-signing prove-signing-surfaces prove-shim-pointer-containment prove-verify-receipt-bind prove-node-pack prove-release-targets prove-gh-timeout-live; do
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
