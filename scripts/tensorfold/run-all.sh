#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/tensorfold/** src/commands/tensorfold/**
# gate-watch: src/services/localServer/localWindowFit.ts
# gate-watch: src/components/tensorfold/** src/utils/model/modelPickerGroups.ts src/utils/model/modelPickerFooter.ts
# gate-watch: src/services/providers/local/tensorfoldHelper.ts src/services/lan/pairing.ts src/services/host/tensorfoldPod.ts src/services/host/tensorfoldRelease.ts
# gate-watch: src/entrypoints/tensorfoldAdapter.ts src/utils/ownerWatch.ts src/utils/archive/zip.ts
# gate-watch: src/services/providers/openaicompat/compatWire.ts
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
