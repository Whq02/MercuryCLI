#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/media/** src/commands/imagesetup/** src/components/Settings/Media.tsx src/components/Settings/Config.tsx src/services/localServer/localServerTruth.ts
# gate-watch: src/extensions/** src/components/extensions/rowWords.ts src/utils/settings/types.ts src/utils/healthReport.ts
# gate-watch: src/components/permissions/MediaPermissionRequest.tsx src/components/permissions/PermissionRequest.tsx src/commands.ts src/utils/cockpit/settingsPopup.ts
# gate-watch: docs/MEDIA.md docs/README.md scripts/lib/hermetic.ts src/services/mcp/client.ts src/services/mcp/sdk.ts src/Tool.ts src/utils/permissions/decision/engine.ts src/utils/settings/settings.ts
# gate-watch: src/bootstrap/state.ts src/ink.ts src/services/mcp/sessionKitPin.ts src/services/mcp/useManageMCPConnections.ts src/state/AppState.tsx src/state/store.ts src/utils/config.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
cd "$(dirname "$0")/../.." || exit 1
here="$(pwd)/scripts/media"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for proof in "$here"/prove-*.ts; do
  start=$SECONDS; rc=0
  "$bun" run "$proof" || { rc=$?; fail=1; }
  printf '── scripts/media/%s  %ss rc=%s\n' "$(basename "$proof")" "$(( SECONDS - start ))" "$rc"
done
exit "$fail"
