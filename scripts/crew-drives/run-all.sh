#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/services/crewBoard/** src/commands/swarm/** src/components/prompts-panel/** src/components/mercuryPalette.ts src/utils/mercuryTokens.ts
# gate-watch: src/daemon/concourseWorkers.ts src/daemon/** src/cli/run.ts src/ink.ts
# gate-watch: scripts/ui/vshot.py scripts/ui/gridToPng.ts scripts/ui/renderScenarios.ts scripts/lib/captureDriver.ts scripts/lib/firstRunSeed.ts scripts/lib/seedTranscript.ts
# gate-watch: scripts/crew/prove-swarm-chat.ts scripts/crew/prove-swarm-mention-row.ts src/utils/messages/noticeRows.ts src/utils/sessionStoragePortable.ts
# gate-watch: scripts/crew/prove-swarm-owner-verbs.ts src/utils/crew/channelCommand.ts src/commands.ts src/commands/general/** src/commands/team/** src/commands/whisper/** src/commands/swarm/swarm.ts src/bootstrap/state.ts src/utils/config/globalConfig.ts src/utils/settings/settings.ts src/utils/messages/authWallHold.ts src/utils/messages/factories.ts src/utils/messages/systemMessages.ts src/utils/markdown.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/crew-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'crew-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members crew-drives 'scripts/crew/$name' "$here/members.txt"
