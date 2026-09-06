
import { randomUUID } from 'node:crypto'
import { getSdkBetas, getSessionId } from '../../bootstrap/state.js'
import type { Tools } from '../../Tool.js'
import type { Command } from '../../commands.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { PermissionMode } from '../../types/permissions.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import type { SDKMessage } from '../../entrypoints/agentSdkTypes.js'
import { getCwd } from '../cwd.js'

export type SystemInitInputs = {
  tools: Tools
  mcpClients: MCPServerConnection[]
  model: string
  permissionMode: PermissionMode
  commands: Command[]
  agents: AgentDefinition[]
  skills: Command[]
  extensions: Array<{ name: string; path: string; source: string }>
}

function isInvocable(entry: { userInvocable?: boolean }): boolean {
  return entry.userInvocable !== false
}

export function buildSystemInitMessage(inputs: SystemInitInputs): SDKMessage {
  const message = {
    type: 'system' as const,
    subtype: 'init' as const,
    cwd: getCwd(),
    session_id: getSessionId(),
    tools: inputs.tools.map(tool => tool.name),
    mcp_servers: inputs.mcpClients.map(client => ({
      name: client.name,
      status: client.type,
    })),
    model: inputs.model,
    permission_mode: inputs.permissionMode,
    slash_commands: inputs.commands.filter(isInvocable).map(command => command.name),
    betas: getSdkBetas() ?? [],
    mercury_version: MACRO.VERSION,
    agents: inputs.agents.map(agent => agent.agentType),
    skills: inputs.skills.filter(isInvocable).map(skill => skill.name),
    extensions: inputs.extensions.map(extension => ({
      name: extension.name,
      path: extension.path,
      source: extension.source,
    })),
    uuid: randomUUID(),
  }
  return message as unknown as SDKMessage
}
