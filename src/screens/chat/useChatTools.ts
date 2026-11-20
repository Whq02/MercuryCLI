import { useRef } from 'react';
import { usePublish } from '../../hooks/effects.js';
import type { Command } from '../../commands.js';
import { useMcpConnectivityStatus } from '../../hooks/notifs/useMcpConnectivityStatus.js';
import { useApiKeyVerification } from '../../hooks/useApiKeyVerification.js';
import { useMergedCommands } from '../../hooks/useMergedCommands.js';
import { useMergedTools } from '../../hooks/useMergedTools.js';
import { useAppState } from '../../state/AppState.js';
import type { Tool } from '../../Tool.js';
import { publishMcpConnections } from '../../utils/cockpit/mcpGauge.js';

export function useChatTools({ initialCommands, initialTools }: { initialCommands: Command[]; initialTools: Tool[] }) {
  const mcpState = useAppState(state => state.mcp);
  usePublish(() => {
    publishMcpConnections(mcpState.clients);
  }, [mcpState.clients]);
  useMcpConnectivityStatus({ mcpClients: mcpState.clients });
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
