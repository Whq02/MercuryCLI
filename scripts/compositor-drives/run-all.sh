#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_RENDER_CWD
# gate-watch: assets/splash/mercury-splash.mjs src/commands/** src/components/*
# gate-watch: src/components/Settings/Config.tsx src/components/concourse/*
# gate-watch: src/components/mercury-ui/sessionAccent.ts src/entrypoints/cli.tsx src/hooks/useTextInput.ts
# gate-watch: src/ink/* src/ink/components/AlternateScreen.tsx src/ink/components/App.tsx
# gate-watch: src/ink/geometry/selection-model.ts src/ink/root/screen-session.ts
# gate-watch: src/ink/root/terminalModeLedger.ts src/ink/session/terminalExperience.ts src/ink/termio/*
# gate-watch: src/interactiveHelpers.tsx src/keybindings/* src/prompt/mercuryContract.ts src/screens/Chat.tsx
# gate-watch: src/screens/ResumeConversation.tsx src/ink/termio/notifyPing.ts src/hooks/useTurnEndPing.ts
# gate-watch: src/services/providers/openai/openaiCallModel.ts src/services/providers/openai/openaiWire.ts
# gate-watch: src/skills/bundled/keybindings.ts src/utils/bash/ShellSnapshot.ts src/utils/cockpit/*
# gate-watch: src/utils/config/schema.ts src/utils/mercuryTokens.ts src/utils/messages/streaming.ts src/utils/truncate.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/compositor-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'compositor-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members compositor-drives 'scripts/compositor/$name' "$here/members.txt"
