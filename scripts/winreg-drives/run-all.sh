#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/lib/settingsPopupHarness.ts
# gate-watch: scripts/winreg/** package.json src/daemon/runPtyHost.ts scripts/lib/nodeBin.ts
# gate-watch: src/Task.ts src/Tool.ts src/bootstrap/state.ts src/cli/structuredIO.ts src/daemon/*
# gate-watch: src/hooks/useSkillsChange.ts src/native-ts/file-index/index.ts
# gate-watch: src/services/privateChannel/installLayout.ts src/services/privateChannel/updateService.ts
# gate-watch: src/utils/* src/utils/config/globalConfig.ts src/utils/permissions/filesystem.ts
# gate-watch: src/utils/secureStorage/plainTextStorage.ts
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/utils/health/sections/crew.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/winreg-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'winreg-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members winreg-drives 'scripts/winreg/$name' "$here/members.txt"
