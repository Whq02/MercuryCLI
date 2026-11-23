#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/integrations/extensions/active.ts src/integrations/extensions/blocklist.ts src/integrations/extensions/boot.ts src/integrations/extensions/bundled/** src/integrations/extensions/card.ts src/integrations/extensions/catalogue.ts src/integrations/extensions/cli.ts src/integrations/extensions/health.ts src/integrations/extensions/install.ts src/integrations/extensions/installConsent.ts src/integrations/extensions/load/agents.ts src/integrations/extensions/load/commands.ts src/integrations/extensions/load/contributions.ts src/integrations/extensions/load/hooks.ts src/integrations/extensions/load/keybindings.ts src/integrations/extensions/load/language.ts src/integrations/extensions/load/optionSchema.ts src/integrations/extensions/load/servers.ts src/integrations/extensions/manifest.ts src/integrations/extensions/options.ts src/integrations/extensions/paths.ts src/integrations/extensions/records.ts src/integrations/extensions/reload.ts src/integrations/extensions/roster.ts src/integrations/extensions/sources.ts src/integrations/extensions/tree.ts src/integrations/extensions/types.ts src/integrations/extensions/validate.ts src/integrations/skills/loadSkillsDir.ts src/integrations/event-hooks/answer.ts src/integrations/event-hooks/background.ts src/integrations/event-hooks/commandRunner.ts src/integrations/event-hooks/contextBound.ts src/integrations/event-hooks/contract.ts src/integrations/event-hooks/fileChangedWatcher.ts src/integrations/event-hooks/fire.ts src/integrations/event-hooks/hookEvents.ts src/integrations/event-hooks/hooksConfigManager.ts src/integrations/event-hooks/hooksConfigSnapshot.ts src/integrations/event-hooks/hooksSettings.ts src/integrations/event-hooks/matcherGrammar.ts src/integrations/event-hooks/matching.ts src/integrations/event-hooks/registerFrontmatterHooks.ts src/integrations/event-hooks/rows.ts src/integrations/event-hooks/runnerRegistry.ts src/integrations/event-hooks/sessionHooks.ts src/integrations/event-hooks/toolPermission.ts src/integrations/event-hooks/wait.ts
# gate-watch: scripts/lib/captureDriver.ts
# gate-watch: scripts/ui/renderScenarios.ts scripts/ui/vshot.py
# gate-watch: src/commands/extensions/**
# gate-watch: src/screen/extensions/ApprovalCardView.tsx src/screen/extensions/ExtensionView.tsx src/screen/extensions/ExtensionsBoard.tsx src/screen/extensions/SourceView.tsx src/screen/extensions/bindings.ts src/screen/extensions/board/** src/screen/extensions/rowWords.ts
# gate-watch: src/integrations/mcp/InProcessTransport.ts src/integrations/mcp/anthropicConnectors.ts src/integrations/mcp/auth.ts src/integrations/mcp/automationAccess.ts src/integrations/mcp/automationBridge.ts src/integrations/mcp/automationGateway.ts src/integrations/mcp/automationServer.ts src/integrations/mcp/client.ts src/integrations/mcp/configPaths.ts src/integrations/mcp/dateTimeParser.ts src/integrations/mcp/disabledRecord.ts src/integrations/mcp/dynamicMcpSeed.ts src/integrations/mcp/elicitationHandler.ts src/integrations/mcp/elicitationValidation.ts src/integrations/mcp/envExpansion.ts src/integrations/mcp/eraVerdictCache.ts src/integrations/mcp/kitCompletion.ts src/integrations/mcp/kitDial.ts src/integrations/mcp/kitStore.ts src/integrations/mcp/lazyStdio.ts src/integrations/mcp/liveConfig.ts src/integrations/mcp/mcpOutputStorage.ts src/integrations/mcp/mcpOutputTruncation.ts src/integrations/mcp/membership.ts src/integrations/mcp/mercuryServer.ts src/integrations/mcp/oauthPort.ts src/integrations/mcp/presetStore.ts src/integrations/mcp/protocolRevision.ts src/integrations/mcp/renderTuiTool.ts src/integrations/mcp/serverConfigs.ts src/integrations/mcp/serverHeaders.ts src/integrations/mcp/sessionKitPin.ts src/integrations/mcp/stdioCommandSafety.ts src/integrations/mcp/toolsAnswer.ts src/integrations/mcp/utils.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/extensions"
fail=0
echo "############################################################"
echo "# extensions — proof suite"
echo "############################################################"
drive_members extensions 'scripts/extensions/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL EXTENSIONS PROOFS PASS"; else echo "# ❌ SOME EXTENSIONS PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
