#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_CLOSE_CHORD_KEEP MERCURY_SOVEREIGN_DRIVE_CAPTURE_DIR
# gate-watch: scripts/switchboard/**
# gate-watch: src/screen/concourse/**
# gate-watch: src/daemon/switchboard/attachedSession.ts
# gate-watch: scripts/lib/*
# gate-watch: src/screen/keys/KeybindingContext.tsx src/screen/keys/KeybindingProviderSetup.tsx src/screen/keys/RouteSurfaceScope.ts src/screen/keys/actionGraph.ts src/screen/keys/atlas.ts src/screen/keys/defaultBindings.ts src/screen/keys/delivery.ts src/screen/keys/keyCapture.ts src/screen/keys/loadUserBindings.ts src/screen/keys/match.ts src/screen/keys/parser.ts src/screen/keys/pendingChordMirror.ts src/screen/keys/reservedShortcuts.ts src/screen/keys/resolver.ts src/screen/keys/schema.ts src/screen/keys/shortcutFormat.ts src/screen/keys/template.ts src/screen/keys/types.ts src/screen/keys/useKeybinding.ts src/screen/keys/useShortcutDisplay.ts src/screen/keys/validate.ts src/screen/keys/writeBindings.ts
# gate-watch: src/models/facts/aliases.ts src/models/facts/betasClearing.ts src/models/facts/builtInModelTable.ts src/models/facts/capabilities.ts src/models/facts/capabilityRegistry.ts src/models/facts/check1mAccess.ts src/models/facts/chooseAModel.ts src/models/facts/contextWindowUpgradeCheck.ts src/models/facts/deadThinkingPlaceholder.ts src/models/facts/defaultProviderRung.ts src/models/facts/deprecation.ts src/models/facts/inactiveCapabilityLookup.ts src/models/facts/internalModels.ts src/models/facts/loginWords.ts src/models/facts/modelLookup.ts src/models/facts/modelNameMatcher.ts src/models/facts/modelNames.ts src/models/facts/modelPickerFooter.ts src/models/facts/modelPickerGroups.ts src/models/facts/modelUseLedger.ts src/models/facts/pinnedModelIds.ts src/models/facts/providers.ts src/models/facts/seatReceipts.ts src/models/facts/seatSlots.ts src/models/facts/settingResolution.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/switchboard-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'switchboard-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members switchboard-drives 'scripts/switchboard/$name' "$here/members.txt"
