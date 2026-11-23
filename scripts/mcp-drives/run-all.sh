#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/integrations/mcp/InProcessTransport.ts src/integrations/mcp/anthropicConnectors.ts src/integrations/mcp/auth.ts src/integrations/mcp/automationAccess.ts src/integrations/mcp/automationBridge.ts src/integrations/mcp/automationGateway.ts src/integrations/mcp/automationServer.ts src/integrations/mcp/client.ts src/integrations/mcp/client/** src/integrations/mcp/configPaths.ts src/integrations/mcp/dateTimeParser.ts src/integrations/mcp/disabledRecord.ts src/integrations/mcp/dynamicMcpSeed.ts src/integrations/mcp/elicitationHandler.ts src/integrations/mcp/elicitationValidation.ts src/integrations/mcp/envExpansion.ts src/integrations/mcp/eraVerdictCache.ts src/integrations/mcp/kitCompletion.ts src/integrations/mcp/kitDial.ts src/integrations/mcp/kitStore.ts src/integrations/mcp/lazyStdio.ts src/integrations/mcp/liveConfig.ts src/integrations/mcp/mcpOutputStorage.ts src/integrations/mcp/mcpOutputTruncation.ts src/integrations/mcp/membership.ts src/integrations/mcp/mercuryServer.ts src/integrations/mcp/oauthPort.ts src/integrations/mcp/presetStore.ts src/integrations/mcp/protocolRevision.ts src/integrations/mcp/renderTuiTool.ts src/integrations/mcp/serverConfigs.ts src/integrations/mcp/serverHeaders.ts src/integrations/mcp/sessionKitPin.ts src/integrations/mcp/stdioCommandSafety.ts src/integrations/mcp/toolsAnswer.ts src/integrations/mcp/utils.ts src/platform/shell/shellExec.ts src/platform/shell/shellProcess.ts
# gate-watch: src/platform/config/**
# gate-watch: src/commands/mcp/* src/screen/mcp/ElicitationDialog.tsx src/screen/mcp/MCPReconnect.tsx src/screen/mcp/MCPSettings.tsx src/daemon/session-seat/sessionKit.ts src/daemon/session-seat/sessionKitOp.ts src/daemon/control/controlServer.ts src/engine/connector/*
# gate-watch: src/daemon/control/main.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/mcp-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'mcp-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members mcp-drives 'scripts/mcp/$name' "$here/members.txt"
