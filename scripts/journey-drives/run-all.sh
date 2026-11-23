#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/journey/**
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/permissions/guards/mission.ts src/sessions/mission-card/missionCard.ts src/sessions/resume/sessionRestore.ts
# gate-watch: src/models/roads/anthropic/anthropicAdapter.ts src/models/roads/anthropic/anthropicCatalogue.ts src/models/roads/anthropic/anthropicClient.ts src/models/roads/anthropic/anthropicLogin.ts src/models/roads/anthropic/anthropicStream.ts src/models/roads/anthropic/anthropicUsageState.ts src/models/roads/anthropic/anthropicWorkspace.ts src/models/roads/anthropic/boundPrefixRecord.ts src/models/roads/anthropic/cacheAndUsage.ts src/models/roads/anthropic/cacheDiagnostics.ts src/models/roads/anthropic/index.ts src/models/roads/anthropic/media.ts src/models/roads/anthropic/messageEffort.ts src/models/roads/anthropic/messageParams.ts src/models/roads/anthropic/modelRefusal.ts src/models/roads/anthropic/prefixLedger.ts src/models/roads/anthropic/prefixRecordStore.ts src/models/roads/anthropic/requestParams.ts src/models/roads/anthropic/stream-core/** src/models/roads/anthropic/streamCore.ts src/models/roads/anthropic/thinkingBinding.ts src/models/roads/anthropic/thinkingDisplay.ts src/models/roads/anthropic/toolIds.ts src/models/roads/toolEconomy.ts src/engine/requests/dumpPrompts.ts
# gate-watch: src/screen/widgets/parity/AccountView.tsx src/models/roads/accountSlots.ts
# gate-watch: src/screen/widgets/faces/anthropicLoginModel.ts src/models/sign-in/oauth/auth-code-listener.ts src/models/sign-in/oauth/client.ts src/models/sign-in/oauth/crypto.ts src/models/sign-in/oauth/index.ts src/models/sign-in/oauth/refresh.ts src/screen/boot-face/BootLoginsScreen.tsx
# gate-watch: scripts/lib/*
# gate-watch: src/screen/app-state/AppStateStore.ts
# gate-watch: src/engine/rows/* src/daemon/runner-wire/*
# gate-watch: src/platform/environment/platform.ts
# gate-watch: src/models/catalogue/modelTransition.ts src/screen/composer/useComposerModelDoors.tsx
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
