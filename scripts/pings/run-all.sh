#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/pings/**
# gate-watch: src/hooks/useTurnEndPing.ts src/ink/termio/notifyPing.ts src/ink/session/focus-store.ts
# gate-watch: src/ink/terminalWrite.ts src/utils/settings/types.ts src/services/attention/**
# gate-watch: src/bootstrap/state.ts src/utils/settings/settingsCache.ts scripts/settings/settings-schema.json
# gate-watch: src/components/permissions/PermissionRequest.tsx src/components/mcp/ElicitationDialog.tsx
# gate-watch: src/components/MercuryFrame.tsx src/services/engine-connector/daemonConnector.ts
# gate-watch: src/components/messages/SystemTextMessage.tsx
# gate-watch: scripts/lib/captureDriver.ts scripts/lib/firstRunSeed.ts scripts/lib/fixtureApi.ts scripts/ui/vshot.py
# gate-watch: scripts/streaming/artifactArena.ts src/commands.ts
# gate-watch: src/commands/model/mercuryModel.tsx src/commands/model/model.tsx
# gate-watch: src/components/HelpV2/commandDomains.ts src/components/PromptInput/PromptInput.tsx
# gate-watch: src/components/Settings/Config.tsx src/components/concourse/ConcourseStrips.tsx
# gate-watch: src/components/mercury-ui/needsYouJump.ts src/constants/figures.ts src/daemon/sessionSeat.ts
# gate-watch: src/fabric/entryCodec.ts src/fabric/ordinal.ts src/hooks/useGlobalKeybindings.tsx
# gate-watch: src/keybindings/actionGraph.ts src/keybindings/defaultBindings.ts src/screens/Chat.tsx
# gate-watch: src/services/crew/obligations.ts src/services/crew/obligationsBridge.ts
# gate-watch: src/services/engine-connector/seatProjections.ts src/utils/*
# gate-watch: src/components/PromptInput/useComposerModelDoors.tsx
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# pings — one ping when a chat finishes its turn while you are away"
echo "############################################################"

for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; (cd "$repo" && "$bun" run "$proof") || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done

for journey in "$here"/journey-*.ts; do
  [ -e "$journey" ] || continue
  echo
  echo "── $(basename "$journey") (machine-gated) ──"
  __t=$SECONDS; __rc=0
  (cd "$repo" && "$bun" run "$journey")
  got=$?; __rc=$got
  prover_mark "$journey" "$__t" "$__rc"
  if [ "$got" = "3" ]; then
    echo "⏭  $(basename "$journey") SKIP — machine gate honoured"
  elif [ "$got" != "0" ]; then
    echo "❌ $(basename "$journey") exited $got (0 = pass, 3 = machine-gate SKIP)"
    fail=1
  fi
done

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ pings PASS"; else echo "# ❌ pings FAILED"; fi
echo "############################################################"
exit "$fail"
