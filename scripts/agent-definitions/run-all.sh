#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/crew/agents/codec.ts src/crew/agents/contracts.ts src/crew/agents/forkedAgent.ts src/crew/agents/operatorStop.ts src/crew/agents/overrides.ts src/crew/agents/resolver.ts src/crew/agents/store.ts src/crew/agents/watch.ts src/engine/system-prompt/systemPromptParts.ts src/screen/agents/ColorPicker.tsx src/screen/agents/ModelSelector.tsx src/screen/agents/ToolSelector.tsx src/screen/agents/generateCrewmate.ts src/screen/agents/utils.ts src/platform/settings/markdownConfigLoader.ts
# gate-watch: src/screen/agents/studio/*
# gate-watch: src/tools/crewmate/CrewmateTool.tsx src/tools/crewmate/agentPermissionPosture.ts src/tools/crewmate/agentToolRules.ts src/tools/crewmate/builtInAgents.ts src/tools/crewmate/continuationNote.ts src/tools/crewmate/crewmateColors.ts src/tools/crewmate/crewmateLifecycle.ts src/tools/crewmate/foregroundExecution.tsx src/tools/crewmate/frozenWorktreeNotice.ts src/tools/crewmate/liveAgentOwner.ts src/tools/crewmate/loadAgentsDir.ts src/tools/crewmate/prompt.ts src/tools/crewmate/refusalRetry.ts src/tools/crewmate/resumeCrewmate.ts src/tools/crewmate/reviewerPolicy.ts src/tools/crewmate/rows.tsx src/tools/crewmate/runCrewmate.ts src/tools/crewmate/scoutPolicy.ts src/tools/crewmate/worktreePrepareNotice.ts
# gate-watch: src/engine/loop/turn/**
# gate-watch: src/daemon/runner/claimSession.ts src/daemon/runner/controlHandlers.ts src/daemon/runner/hostAskLiveness.ts src/daemon/runner/inputDoor.ts src/daemon/runner/mcpArms.ts src/daemon/runner/model.ts src/daemon/runner/parkRefusal.ts src/daemon/runner/projectQuery.ts src/daemon/runner/refusalEnvelope.ts src/daemon/runner/restartCarry.ts src/daemon/runner/resume.ts src/daemon/runner/resumeHydration.ts src/daemon/runner/runnerArms.ts src/daemon/runner/runnerAsks.ts src/daemon/runner/runnerDriver.ts src/daemon/runner/runnerMethods.ts src/daemon/runner/runnerPorts.ts src/daemon/runner/runnerRunEnd.ts src/daemon/runner/runnerTurn.ts src/daemon/runner/sendNow.ts src/daemon/runner/sessionFactsArm.ts src/daemon/runner/spawnSwitchLanding.ts src/daemon/runner/turnDriver.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/agent-definitions"
fail=0
export MERCURY_EVOLUTION_LEDGER=0
echo "############################################################"
echo "# agent-definitions — Agent Studio proof harness"
echo "############################################################"
drive_members agent-definitions 'scripts/agent-definitions/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL agent-definitions PROOFS PASS"; else echo "# ❌ SOME agent-definitions PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
