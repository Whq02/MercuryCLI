import { useRef } from 'react';
import { usePublish } from '../effects/effects.js';
import type { Command } from '../../commands/catalogue/commands.js';
import { useMcpConnectionNotices } from '../notifications/useMcpConnectionNotices.js';
import { useApiKeyVerification } from '../../models/sign-in/credentials/useApiKeyVerification.js';
import { useMergedCommands } from '../../commands/catalogue/useMergedCommands.js';
import { useMergedTools } from '../../tools/kit/useMergedTools.js';
import { useAppState } from '../app-state/AppState.js';
import type { Tool } from '../../tools/kit/tool.js';
import { publishMcpConnections } from '../cockpit-gauges/mcpGauge.js';

export function useChatTools({ initialCommands, initialTools }: { initialCommands: Command[]; initialTools: Tool[] }) {
  const mcpState = useAppState(state => state.mcp);
  usePublish(() => {
    publishMcpConnections(mcpState.clients);
  }, [mcpState.clients]);
  useMcpConnectionNotices({ mcpClients: mcpState.clients });
  const toolPermissionContext = useAppState(state => state.toolPermissionContext);
  const agentDefinitions = useAppState(state => state.agentDefinitions);
  const verbose = useAppState(state => state.verbose);
  const spinnerTip = useAppState(state => state.spinnerTip);
  const commands = useMergedCommands(initialCommands, mcpState.commands);
  const mergedTools = useMergedTools(initialTools, mcpState.tools, toolPermissionContext);
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const apiKeyVerification = useApiKeyVerification();
  return { mcpState, toolPermissionContext, agentDefinitions, verbose, spinnerTip, commands, mergedTools, commandsRef, apiKeyVerification };
}
