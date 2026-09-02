#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/privateChannel/** src/cli/update.ts src/cli/installVerb.ts
# gate-watch: scripts/release/** .github/workflows/private-release.yml package.json src/constants/changelog.ts THIRD_PARTY_NOTICES.md
# gate-watch: assets/splash/mercury-splash.mjs src/utils/windowsPaths.ts
# scripts/updater/run-all.sh — the PRIVATE release channel (install/update/
# rollback verbs over the collaborator's own gh): the pure core, the
# versioned install layout, the end-to-end journey against the built
# artifact, the §5 version contract, and the never-public ratchet
#
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root" || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "── PRIVATE CHANNEL — updater/installer proofs ──"
for prover in prove-channel-core prove-status-check-agreement prove-install-layout prove-version-contract prove-release-workflow prove-never-public prove-splash-ship prove-gitbash-resolution prove-update-journey prove-artifact-signing prove-signing-surfaces prove-shim-pointer-containment prove-verify-receipt-bind prove-node-pack; do
  echo ""
  echo "▶ $prover"
  "$BUN" run "$here/$prover.ts" || fail=1
done

# The ARCHIVE lane: prove-archive-journey walks the PACKAGED host archive in
# release-out/ through its own launcher and the stable command (install →
# check → status → update → rollback → uninstall). It skips loudly when no
# archive is packaged, so the default pool stays self-contained; the release
# recipe packages first, then runs this suite.
echo ""
echo "▶ prove-archive-journey (archive lane — runs when release-out/ holds the host archive)"
"$BUN" run "$here/prove-archive-journey.ts" || fail=1

# The NETWORK lane (UPD-14): prove-release-bridge downloads the PREVIOUS
# release's real shipped reader via gh and drives it against the candidate
# archive — deliberately NOT in the default pool. Opt in locally pre-tag
# (MERCURY_UPDATER_NETWORK=1 after packaging the host target); the release
# workflow runs it per-OS as the bridge-gate job between package and release.
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
