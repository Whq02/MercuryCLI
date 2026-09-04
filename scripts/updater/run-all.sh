#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/privateChannel/** src/cli/update.ts src/cli/installVerb.ts
# gate-watch: scripts/release/** .github/workflows/private-release.yml package.json src/constants/changelog.ts THIRD_PARTY_NOTICES.md
# gate-watch: assets/splash/mercury-splash.mjs src/utils/windowsPaths.ts
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root" || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "── PRIVATE CHANNEL — updater/installer proofs ──"
for prover in prove-channel-core prove-status-check-agreement prove-install-layout prove-install-path prove-version-contract prove-release-workflow prove-never-public prove-splash-ship prove-gitbash-resolution prove-update-journey prove-artifact-signing prove-signing-surfaces prove-shim-pointer-containment prove-verify-receipt-bind prove-node-pack; do
  echo ""
  echo "▶ $prover"
  "$BUN" run "$here/$prover.ts" || fail=1
done

echo ""
echo "▶ prove-archive-journey (archive lane — runs when release-out/ holds the host archive)"
"$BUN" run "$here/prove-archive-journey.ts" || fail=1

if [[ "${MERCURY_UPDATER_NETWORK:-}" == "1" ]]; then
  echo ""
  echo "▶ prove-release-bridge (network lane)"
  "$BUN" run "$here/prove-release-bridge.ts" || fail=1
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
