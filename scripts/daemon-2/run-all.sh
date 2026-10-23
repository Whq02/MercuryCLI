#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/daemon/** scripts/daemon-2/**
# gate-watch: src/daemon/** src/substrate/flagRegistry* src/types/permissions* src/components/SwitchboardTagBar.tsx
# gate-watch: src/utils/boxLock* src/services/resources/adapters/health*
# gate-watch: src/services/engine-connector/seatProjections* src/utils/spawnLedger* docs/DURABILITY.md
# gate-watch: src/tools/MonitorTool/** src/tools/ScheduleCronTool/** src/utils/cron.ts src/services/engine-connector/seatWire.ts
# gate-watch: src/cli/headless/turnDriver* src/cli/headless/runnerAsks.ts src/cli/run* src/services/saturn/** src/tools/ScheduleWakeupTool/**
# gate-watch: docs/SESSIONS.md scripts/dap/mock-dap-adapter.mjs scripts/journey/switch-fixture-server.ts
# gate-watch: scripts/lib/* scripts/staleness/prove-stale-registry.ts
# gate-watch: scripts/streaming/turn-end-fixture-server.ts
# gate-watch: scripts/ops/deploy-runtime.sh scripts/ops/launcher-mercury.sh scripts/ops/deploy-launcher.sh scripts/splash/deploy.sh docs/TERMINAL-RUNTIME.md
# gate-watch: src/utils/healthReport.ts src/cli/update.ts src/services/privateChannel/installLayout.ts src/services/privateChannel/vendoredRuntime.ts package.json
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: scripts/lib/seatDoor.ts
# gate-watch: src/services/engine-connector/daemonConnector.ts src/services/engine-connector/seatLive.ts src/components/Spinner/liveCounterWords.ts src/components/Spinner/spinnerHud.ts src/components/Spinner/SpinnerAnimationRow.tsx
# gate-watch: src/tasks/LocalAgentTask/* src/input-core/* src/state/AppState*
# gate-watch: src/cli/editorBridge.ts src/cli/healthProcesses.ts src/constants/tools.ts src/screens/Chat.tsx src/services/acp/childSession.ts
# gate-watch: src/services/blender/bridgeFiles.generated.ts src/services/compact/compact.ts src/services/compact/foldStatus.ts src/services/compact/operatorMessages.ts src/services/compact/prompt.ts
# gate-watch: src/services/concourse/coordinatorTools.ts src/services/concourse/managerMode.ts src/services/crew/adapters/ndjsonChild.ts src/services/dap/debugpyResolver.ts src/services/eval/interpreters.ts
# gate-watch: src/services/eval/kernelEnv.ts src/services/oauth/client.ts src/services/privateChannel/installPath.ts src/services/structure/grammarFacility.ts src/services/switchboard/bootBirthFacts.ts
# gate-watch: src/services/switchboard/bornSession.ts src/services/switchboard/hopIntoSession.ts src/services/tcpBridge/entry.ts src/services/unity/bridgeFiles.generated.ts src/services/vulcan/addonFiles.generated.ts
# gate-watch: src/substrate/directSplash.ts src/substrate/durablePublish.ts src/substrate/fileStore.ts src/tools/AgentTool/constants.ts src/tools/WorkflowTool/constants.ts
# gate-watch: src/utils/accounts/signInLedger.ts src/utils/auth.ts src/utils/config/globalConfig.ts src/utils/editor.ts src/utils/execFileNoThrow.ts
# gate-watch: src/utils/messages/attachmentText.ts src/utils/messages/factories.ts src/utils/messages/normalize.ts src/utils/processGroup.ts src/utils/redactHeaders.ts
# gate-watch: src/services/providers/providerDiscovery.ts src/utils/runtime/win32Console.ts src/utils/secureStorage/index.ts src/utils/sessionStorage/paths.ts src/utils/skills/skillChangeDetector.ts
# gate-watch: src/utils/subprocessEnv.ts src/utils/worktree.ts
# gate-watch: src/services/host/jobCredentials.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/daemon-2"

fail=0
names=()
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  names+=("$name")
done < "$here/members.txt"
if [ "${#names[@]}" -eq 0 ]; then
  echo "❌ daemon-2: $here/members.txt names no prover — an empty slice is a red, never a vacuous green"
  fail=1
fi
for name in ${names[@]+"${names[@]}"}; do
  f="scripts/daemon/$name"
  if [ ! -e "$f" ]; then
    echo "❌ daemon-2: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    fail=1
    continue
  fi
  __t=$SECONDS; __rc=0; "$bun" run "$f" || { __rc=$?; fail=1; }; prover_mark "$f" "$__t" "$__rc"
done
exit "$fail"
