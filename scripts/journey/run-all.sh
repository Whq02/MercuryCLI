#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/utils/sessionStoragePortable*
# gate-watch: src/guards/mission* src/services/mission/missionCard* src/utils/sessionRestore*
# gate-watch: src/services/providers/anthropic/** src/services/providers/toolEconomy.ts src/services/api/dumpPrompts.ts
# gate-watch: src/components/mercury-ui/parity/AccountView* src/services/providers/accountSlots.ts
# gate-watch: src/components/mercury-ui/screens/anthropicLoginModel* src/services/oauth/** src/components/BootLoginsScreen*
# gate-watch: scripts/daemon/dupline-world.ts scripts/lib/* scripts/ui/vshot.py
# gate-watch: src/components/PromptInput/useCrewBanner.ts
# gate-watch: src/constants/figures.ts src/daemon/controlSocket.ts src/daemon/protocol.ts
# gate-watch: src/services/engine-connector/daemonConnector.ts
# gate-watch: src/state/AppStateStore.ts
# gate-watch: src/tools/AgentTool/agentColorManager.ts
# gate-watch: src/utils/imageStore.ts
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/components/mercury-ui/keyHintLabel.ts src/utils/platform.ts
# gate-watch: src/commands/model/model.tsx src/utils/model/modelTransition.ts src/components/PromptInput/useComposerModelDoors.tsx
# gate-watch: src/utils/health/sections/crew.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
claimed=$(cat scripts/journey-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')
dupes=$(printf '%s\n' "$claimed" | sort | uniq -d)
if [ -n "$dupes" ]; then
  echo "❌ journey: prover(s) named by TWO sibling member lists (a double run across shards):"
  printf '%s\n' "$dupes" | sed 's/^/    /'
  fail=1
fi

for f in scripts/journey/prove-*.ts; do
  [ -e "$f" ] || continue
  name=$(basename "$f")
  if printf '%s\n' "$claimed" | grep -qx "$name"; then
    continue
  fi
  echo "▶ $f"
  __t=$SECONDS; __rc=0; if ! { "$BUN" run "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then fail=1; fi; prover_mark "$f" "$__t" "$__rc"
  echo
done
if [ "$fail" -eq 0 ]; then echo "✅ JOURNEY SUITE GREEN"; else echo "❌ JOURNEY SUITE RED"; fi
exit "$fail"
