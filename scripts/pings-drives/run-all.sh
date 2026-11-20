#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/pings/**
# gate-watch: src/utils/settings/types.ts src/services/attention/**
# gate-watch: scripts/settings/settings-schema.json
# gate-watch: src/components/permissions/PermissionRequest.tsx src/components/mcp/ElicitationDialog.tsx
# gate-watch: src/components/MercuryFrame.tsx
# gate-watch: src/components/messages/SystemTextMessage.tsx
# gate-watch: src/commands/model/mercuryModel.tsx src/commands/model/model.tsx
# gate-watch: src/components/HelpV2/commandDomains.ts src/components/PromptInput/PromptInput.tsx
# gate-watch: src/components/Settings/Config.tsx src/components/concourse/ConcourseStrips.tsx
# gate-watch: src/daemon/sessionSeat.ts
# gate-watch: src/services/crew/obligationsBridge.ts
# gate-watch: src/utils/*
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/components/PromptInput/useComposerModelDoors.tsx
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/pings-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'pings-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members pings-drives 'scripts/pings/$name' "$here/members.txt" 3
