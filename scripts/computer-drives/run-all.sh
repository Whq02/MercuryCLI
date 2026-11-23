#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/tools/computer/** src/integrations/desktop/computerAccess.ts src/integrations/desktop/computerGrant.ts src/integrations/desktop/desktopClaim.ts src/integrations/desktop/desktopSession.ts src/integrations/desktop/driver.ts src/integrations/desktop/fakeDesktopDriver.ts src/integrations/desktop/nativeDriver.ts src/integrations/desktop/pack.ts src/integrations/desktop/resolveDriver.ts src/integrations/desktop/screenshotRetention.ts src/integrations/desktop/toolName.ts src/integrations/desktop/webEngine.ts src/screen/composer/ComposerFooterLeftSide.tsx scripts/computer/prove-computer-*-drive.ts build.ts
# gate-watch: scripts/computer/computerProofKit.ts scripts/computer/computerToolKit.ts scripts/lib/* native/desktop/src/{mac,win,x11,lib}.rs
# gate-watch: scripts/computer/fixtures/two-displays.json
# gate-watch: src/platform/settings/config.ts src/platform/settings/configConstants.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/computer-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'computer-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

failed=0
drive_members computer-drives 'scripts/computer/$name' "$here/members.txt" || failed=1
exit "$failed"
