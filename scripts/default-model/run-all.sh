#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/commands/model/*
# gate-watch: src/models/facts/aliases.ts src/models/facts/betasClearing.ts src/models/facts/builtInModelTable.ts src/models/facts/capabilities.ts src/models/facts/capabilityRegistry.ts src/models/facts/check1mAccess.ts src/models/facts/chooseAModel.ts src/models/facts/contextWindowUpgradeCheck.ts src/models/facts/deadThinkingPlaceholder.ts src/models/facts/defaultProviderRung.ts src/models/facts/deprecation.ts src/models/facts/inactiveCapabilityLookup.ts src/models/facts/internalModels.ts src/models/facts/loginWords.ts src/models/facts/modelLookup.ts src/models/facts/modelNameMatcher.ts src/models/facts/modelNames.ts src/models/facts/modelPickerFooter.ts src/models/facts/modelPickerGroups.ts src/models/facts/modelUseLedger.ts src/models/facts/pinnedModelIds.ts src/models/facts/providers.ts src/models/facts/seatReceipts.ts src/models/facts/seatSlots.ts src/models/facts/settingResolution.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/default-model"
fail=0
drive_members default-model 'scripts/default-model/$name' "$here/members.txt" '' run || fail=1
if [ "$fail" -eq 0 ]; then echo "✅ DEFAULT-MODEL SUITE GREEN"; else echo "❌ DEFAULT-MODEL SUITE RED"; fi
exit "$fail"
