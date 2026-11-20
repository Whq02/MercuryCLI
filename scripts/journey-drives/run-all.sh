#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/journey/**
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/guards/mission* src/services/mission/missionCard* src/utils/sessionRestore*
# gate-watch: src/services/providers/anthropic/** src/services/providers/toolEconomy.ts src/services/api/dumpPrompts.ts
# gate-watch: src/components/mercury-ui/parity/AccountView* src/services/providers/accountSlots.ts
# gate-watch: src/components/mercury-ui/screens/anthropicLoginModel* src/services/oauth/** src/components/BootLoginsScreen*
# gate-watch: scripts/lib/*
# gate-watch: src/state/AppStateStore.ts
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/utils/platform.ts
# gate-watch: src/commands/model/model.tsx src/utils/model/modelTransition.ts src/components/PromptInput/useComposerModelDoors.tsx
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
here="scripts/journey-drives"
BUN="${BUN:-$HOME/.bun/bin/bun}"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'journey-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

fail=0
drive_members journey-drives 'scripts/journey/$name' "$here/members.txt" || fail=1
if grep -qx 'prove-overload-lane-resume-drive.ts' "$here/members.txt"; then
  f=scripts/journey/prove-overload-lane-resume-drive.ts
  __t=$SECONDS; __rc=0; "$BUN" run "$f" --budget-cut --gone-cwd || { __rc=$?; fail=1; }; prover_mark "$f --budget-cut --gone-cwd" "$__t" "$__rc"
  __t=$SECONDS; __rc=0; "$BUN" run "$f" --budget-cut --inline || { __rc=$?; fail=1; }; prover_mark "$f --budget-cut --inline" "$__t" "$__rc"
fi
exit "$fail"
