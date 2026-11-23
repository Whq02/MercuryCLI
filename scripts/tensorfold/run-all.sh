#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/models/tensorfold/** src/commands/tensorfold/**
# gate-watch: src/models/local-server/localWindowFit.ts
# gate-watch: src/screen/tensorfold/** src/models/facts/modelPickerGroups.ts src/models/facts/modelPickerFooter.ts
# gate-watch: src/models/roads/local/tensorfoldHelper.ts src/daemon/lan/pairing.ts src/models/hosting/tensorfoldPod.ts src/models/hosting/tensorfoldRelease.ts
# gate-watch: src/boot/entrypoints/tensorfoldAdapter.ts src/daemon/control/ownerWatch.ts src/platform/archive/zip.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
cd "$(dirname "$0")/../.." || exit 1
here="scripts/tensorfold"
fail=0
export MERCURY_CREDENTIAL_STORE="[redacted]"
drive_members tensorfold 'scripts/tensorfold/$name' "$here/members.txt" || fail=1
echo
if [ "$fail" -eq 0 ]; then echo "TENSORFOLD SUITE GREEN"; else echo "TENSORFOLD SUITE RED"; fi
exit "$fail"
