#!/usr/bin/env bash
# gate-class: cpu
# gate-env: MERCURY_PROOF_DIST
# gate-watch: src/integrations/mcp/InProcessTransport.ts src/integrations/mcp/anthropicConnectors.ts src/integrations/mcp/auth.ts src/integrations/mcp/automationAccess.ts src/integrations/mcp/automationBridge.ts src/integrations/mcp/automationGateway.ts src/integrations/mcp/automationServer.ts src/integrations/mcp/client.ts src/integrations/mcp/client/** src/integrations/mcp/configPaths.ts src/integrations/mcp/dateTimeParser.ts src/integrations/mcp/disabledRecord.ts src/integrations/mcp/dynamicMcpSeed.ts src/integrations/mcp/elicitationHandler.ts src/integrations/mcp/elicitationValidation.ts src/integrations/mcp/envExpansion.ts src/integrations/mcp/eraVerdictCache.ts src/integrations/mcp/kitCompletion.ts src/integrations/mcp/kitDial.ts src/integrations/mcp/kitStore.ts src/integrations/mcp/lazyStdio.ts src/integrations/mcp/liveConfig.ts src/integrations/mcp/mcpOutputStorage.ts src/integrations/mcp/mcpOutputTruncation.ts src/integrations/mcp/membership.ts src/integrations/mcp/mercuryServer.ts src/integrations/mcp/oauthPort.ts src/integrations/mcp/presetStore.ts src/integrations/mcp/protocolRevision.ts src/integrations/mcp/renderTuiTool.ts src/integrations/mcp/serverConfigs.ts src/integrations/mcp/serverHeaders.ts src/integrations/mcp/sessionKitPin.ts src/integrations/mcp/stdioCommandSafety.ts src/integrations/mcp/toolsAnswer.ts src/integrations/mcp/utils.ts src/platform/shell/shellExec.ts src/platform/shell/shellProcess.ts
# gate-watch: src/commands/mcp/* src/screen/mcp/ElicitationDialog.tsx src/screen/mcp/MCPReconnect.tsx src/screen/mcp/MCPSettings.tsx
# gate-watch: src/platform/settings/projectConfig.ts
# gate-watch: src/screen/renderer/staticRender.tsx src/screen/renderer/elements/TerminalSizeContext.tsx
# gate-watch: src/platform/health/readiness.ts
# gate-watch: src/engine/rows/* sdk/src/** src/daemon/runner/projectQuery.ts
# gate-watch: src/engine/message-shapes/message.ts src/engine/attachment-shapes/attachmentTypes.ts
# gate-watch: src/daemon/runner/claimSession.ts src/daemon/runner/controlHandlers.ts src/daemon/runner/hostAskLiveness.ts src/daemon/runner/inputDoor.ts src/daemon/runner/mcpArms.ts src/daemon/runner/model.ts src/daemon/runner/parkRefusal.ts src/daemon/runner/projectQuery.ts src/daemon/runner/refusalEnvelope.ts src/daemon/runner/restartCarry.ts src/daemon/runner/resume.ts src/daemon/runner/resumeHydration.ts src/daemon/runner/runnerArms.ts src/daemon/runner/runnerAsks.ts src/daemon/runner/runnerDriver.ts src/daemon/runner/runnerMethods.ts src/daemon/runner/runnerPorts.ts src/daemon/runner/runnerRunEnd.ts src/daemon/runner/runnerTurn.ts src/daemon/runner/sendNow.ts src/daemon/runner/sessionFactsArm.ts src/daemon/runner/spawnSwitchLanding.ts src/daemon/runner/turnDriver.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/mcp"
fail=0
echo "############################################################"
echo "# MCP hardening — proof harness"
echo "############################################################"
drive_members mcp 'scripts/mcp/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL MCP PROOFS PASS"; else echo "# ❌ SOME MCP PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
