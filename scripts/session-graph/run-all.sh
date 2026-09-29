#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/session-graph/**
# gate-watch: src/services/attention/** src/services/attention/relations.ts
# gate-watch: src/services/workbench/** src/services/acp/** src/input-core/composer-document.ts
# gate-watch: src/utils/artifacts/** src/utils/sideQuestion.ts
# gate-watch: scripts/engine-durability/harness.ts scripts/lib/codeText.ts scripts/streaming/artifactArena.ts
# gate-watch: scripts/ui/render-tui.ts src/cli/print.ts src/commands/crew/index.ts
# gate-watch: src/components/concourse/ConcourseRoute.tsx src/components/prompts-panel/PromptsPanel.tsx
# gate-watch: src/components/prompts-panel/rows.ts src/hooks/useObligationSignals.ts src/ink/stringWidth.ts
# gate-watch: src/keybindings/defaultBindings.ts src/services/concourse/concourseSnapshot.ts
# gate-watch: src/services/crew/** src/services/notificationPolicy.ts src/services/resources/adapters/crew.ts
# gate-watch: src/daemon/permissionAsks.ts src/daemon/controlServer.ts src/daemon/dispatchDrain.ts
# gate-watch: src/services/resources/registry.ts src/utils/cockpit/helmConsole.ts
# gate-watch: src/components/messages/AttachmentMessage.tsx src/components/messages/PlanApprovalMessage.tsx
# gate-watch: src/components/messages/ShutdownMessage.tsx src/components/messages/TaskAssignmentMessage.tsx
# gate-watch: src/components/mercury-ui/screens/CrewView.tsx src/services/coordination/coordinationService.ts
# gate-watch: src/tools/SendMessageTool/SendMessageTool.ts src/utils/messages/attachmentText.ts
# gate-watch: src/utils/attachments/crewmates.ts src/utils/crew/crewClient.ts src/utils/tasks.ts
# gate-watch: src/utils/swarm/crewmateInit.ts src/utils/swarm/inProcessRunner.ts
# gate-watch: src/utils/swarm/permissionSync.ts src/utils/swarm/leaseGuard.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# session-graph — the living-crew lane"
echo "############################################################"

for proof in "$here"/prove-*.ts; do
  [ -e "$proof" ] || continue
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; (cd "$repo" && "$bun" run "$proof") || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done

for repro in "$here"/repro-*.ts; do
  [ -e "$repro" ] || continue
  echo
  echo "── $(basename "$repro") ──"
  __t=$SECONDS; __rc=0; (cd "$repo" && "$bun" run "$repro") || { __rc=$?; fail=1; }; prover_mark "$repro" "$__t" "$__rc"
done

if [ "${CONSTELLATION_CLOSE_ARC:-0}" = "1" ]; then
  for runner in "$here"/run-journeys.ts "$here"/run-sensitivity.ts; do
    echo
    echo "── $(basename "$runner") (close-arc lane) ──"
    __t=$SECONDS; __rc=0; (cd "$repo" && "$bun" run "$runner") || { __rc=$?; fail=1; }; prover_mark "$runner" "$__t" "$__rc"
  done
fi

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ session-graph PASS"; else echo "# ❌ session-graph FAILED"; fi
echo "############################################################"
exit "$fail"
