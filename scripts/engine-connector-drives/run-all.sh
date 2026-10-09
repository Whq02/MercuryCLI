#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/engine-connector/**
# gate-watch: src/services/engine-connector/** src/hooks/useSessionConnector.ts
# gate-watch: src/screens/Chat.tsx src/components/MercuryFrame.tsx src/components/PromptInput/**
# gate-watch: src/components/permissions/** src/hooks/useCancelRequest.ts src/hooks/useDisplayedSessionModel.ts
# gate-watch: scripts/lib/* scripts/streaming/artifactArena.ts scripts/streaming/turn-end-fixture-server.ts
# gate-watch: scripts/ui/vshot.py src/components/mercury-ui/keyHintLabel.ts src/daemon/controlSocket.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
export BUSY_STALL_DRIVE=1
here="scripts/engine-connector-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'engine-connector-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members engine-connector-drives 'scripts/engine-connector/$name' "$here/members.txt"
