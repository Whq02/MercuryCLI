#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_EXTUI_CAPTURE_DIR MERCURY_EXTUI_ONLY
# gate-watch: scripts/extensions/prove-*-drive.ts src/extensions/bundled/**
# gate-watch: src/services/mcp/sdk.ts
# gate-watch: scripts/extensions/prove-extensions-surface.ts scripts/lib/captureDriver.ts scripts/lib/firstRunSeed.ts scripts/lib/removeScratch.ts scripts/ui/renderScenarios.ts scripts/ui/vshot.py
# gate-watch: docs/EXTENSIONS.md src/commands/extensions/** src/components/extensions/** src/extensions/** src/keybindings/defaultBindings.ts src/keybindings/schema.ts src/utils/sessionStoragePortable.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/extensions-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'extensions-drives: dist/mercury.mjs absent; build before running the Craft drives'
  exit 1
fi

drive_members extensions-drives 'scripts/extensions/$name' "$here/members.txt"
