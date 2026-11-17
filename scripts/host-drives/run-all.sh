#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/host/bashSyntax.mjs scripts/host/prove-host-rent-drive.ts scripts/host/runpodFixture.mjs scripts/lib/ownerOnly.ts scripts/lib/python3.ts scripts/lib/settingsPopupHarness.ts
# gate-watch: scripts/providers/lib/llmhostFixture.ts scripts/streaming/artifactArena.ts scripts/ui/gridToPng.ts src/commands/llmhost/llmhost.tsx src/components/SettingsPopupSlot.tsx src/components/design-system/ThemeProvider.tsx
# gate-watch: src/ink.ts src/services/host/index.ts src/services/host/recipes.ts src/services/host/runpod.ts src/services/host/ssh.ts src/services/host/store.ts
# gate-watch: src/services/host/worker.ts src/services/providers/openaicompat/compatCatalogue.ts src/state/AppState.tsx src/utils/cockpit/settingsPopup.ts src/utils/model/capabilities.ts
# gate-watch: scripts/streaming/ptydrive.py scripts/lib/observed_walk.py
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/host-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'host-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members host-drives 'scripts/host/$name' "$here/members.txt"
