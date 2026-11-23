#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/commands/defaultprovider/**
# gate-watch: src/models/facts/inactiveCapabilityLookup.ts src/models/facts/modelLookup.ts src/models/facts/modelNameMatcher.ts src/models/facts/modelNames.ts src/models/facts/modelPickerFooter.ts src/models/facts/modelPickerGroups.ts src/models/facts/modelUseLedger.ts src/models/facts/pinnedModelIds.ts src/models/sign-in/flow-cards/SignInFlow.tsx
# gate-watch: scripts/lib/captureDriver.ts scripts/ui/vshot.py
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/default-provider"
overall=0
drive_members default-provider 'scripts/default-provider/$name' "$here/members.txt" || overall=1
exit "$overall"
