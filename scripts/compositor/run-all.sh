#!/bin/bash
# gate-class: pty
# gate-env: MERCURY_RENDER_CWD
# gate-watch: assets/splash/mercury-splash.mjs src/commands/** src/components/*
# gate-watch: src/components/Settings/Config.tsx src/components/concourse/*
# gate-watch: src/components/mercury-ui/sessionAccent.ts src/entrypoints/cli.tsx src/hooks/useTextInput.ts
# gate-watch: src/ink/* src/ink/components/AlternateScreen.tsx src/ink/components/App.tsx
# gate-watch: src/ink/geometry/selection-model.ts src/ink/root/screen-session.ts
# gate-watch: src/ink/root/terminalModeLedger.ts src/ink/session/terminalExperience.ts src/ink/termio/*
# gate-watch: src/interactiveHelpers.tsx src/keybindings/* src/prompt/mercuryContract.ts src/screens/REPL.tsx
# gate-watch: src/screens/ResumeConversation.tsx src/services/notifier.ts
# gate-watch: src/services/providers/openai/openaiCallModel.ts src/services/providers/openai/openaiWire.ts
# gate-watch: src/skills/bundled/keybindings.ts src/utils/bash/ShellSnapshot.ts src/utils/cockpit/*
# gate-watch: src/utils/config/schema.ts src/utils/mercuryTokens.ts src/utils/messages/streaming.ts
# gate-watch: src/utils/sessionStoragePortable.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1

BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0

run() {
  echo "── $1"
  local __t=$SECONDS __rc=0
  if ! { "$BUN" run "$1"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    fail=1
  fi
  prover_mark "$1" "$__t" "$__rc"
}

run scripts/compositor/prove-ground-owner.ts
run scripts/compositor/prove-fill-law.ts
run scripts/compositor/prove-stable-identity.ts
run scripts/compositor/prove-surface-census.ts
run scripts/compositor/prove-hold-takeover.ts
run scripts/compositor/prove-resize-ghost.ts
run scripts/compositor/prove-uiux-wave0-census.ts
run scripts/compositor/prove-ground-contrast-floors.ts
run scripts/compositor/prove-field-findings-keytruth.ts

exit "$fail"
