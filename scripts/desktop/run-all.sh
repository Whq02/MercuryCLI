#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/integrations/desktop/computerAccess.ts src/integrations/desktop/computerGrant.ts src/integrations/desktop/desktopClaim.ts src/integrations/desktop/desktopSession.ts src/integrations/desktop/driver.ts src/integrations/desktop/fakeDesktopDriver.ts src/integrations/desktop/nativeDriver.ts src/integrations/desktop/pack.ts src/integrations/desktop/resolveDriver.ts src/integrations/desktop/screenshotRetention.ts src/integrations/desktop/toolName.ts src/integrations/desktop/webEngine.ts native/desktop/** build.ts scripts/release/package.mjs
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
cd "$(dirname "$0")/../.." || exit 1
here="scripts/desktop"
fail=0
export MERCURY_CREDENTIAL_STORE="${MERCURY_CREDENTIAL_STORE:-file}"
drive_members desktop 'scripts/desktop/$name' "$here/members.txt" '' run || fail=1
if [ "$fail" -eq 0 ]; then echo "✅ DESKTOP SUITE GREEN"; else echo "❌ DESKTOP SUITE RED"; fi
exit "$fail"
