#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_CLOSE_CHORD_KEEP MERCURY_SOVEREIGN_DRIVE_CAPTURE_DIR
# gate-watch: scripts/switchboard/**
# gate-watch: src/services/concourse/** src/components/concourse/** src/daemon/concourseWorkers.ts
# gate-watch: src/daemon/concourseDispatch.ts src/daemon/permissionAsks.ts src/services/switchboard/attachedSession.ts
# gate-watch: src/components/SwitchboardTagBar.tsx src/context/surfaceRoute.ts
# gate-watch: src/prompt/engineIdentity.ts src/constants/prompts.ts
# gate-watch: scripts/lib/* scripts/notifications/concourseReferenceSeed.ts scripts/streaming/artifactArena.ts
# gate-watch: scripts/ui/vshot.py src/components/BootSplashScreen.tsx
# gate-watch: src/components/mercury-ui/glyphs.ts src/components/mercury-ui/keyHintLabel.ts
# gate-watch: src/daemon/controlServer.ts src/daemon/controlSocket.ts src/keybindings/*
# gate-watch: src/screens/ResumeConversation.tsx src/services/crew/obligations.ts
# gate-watch: src/services/engine-connector/seatProjections.ts src/services/switchboard/bornSession.ts
# gate-watch: src/services/switchboard/hopIntoSession.ts src/substrate/launchMilestones.ts src/utils/config.ts
# gate-watch: src/utils/model/* src/utils/sessionStorage/paths.ts src/utils/sessionStorage/transcriptReader.ts
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
