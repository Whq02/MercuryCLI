// ============================================================================
//  The `system`/`init` SDK stream message: session metadata for remote
//  clients, emitted as the first message on the SDK stream by the query
//  engine. A second intended emitter (the REPL remote-control bridge) is
//  absent from this build; the identical-shape duty binds only if that
//  surface returns.
// ============================================================================

import { randomUUID } from 'node:crypto'
import { getSdkBetas, getSessionId } from '../../bootstrap/state.js'
import type { Tools } from '../../Tool.js'
import type { Command } from '../../commands.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { PermissionMode } from '../../types/permissions.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import type { SDKMessage } from '../../entrypoints/agentSdkTypes.js'
import { getAnthropicApiKeyWithSource } from '../auth.js'
import { getCwd } from '../cwd.js'

export type SystemInitInputs = {
  /** The live tool list; names are emitted as-is (the Agent→Task compat
   *  wire rename is retired). */
  tools: Tools
  /** MCP connections; the emitted status is the client's TYPE field. */
  mcpClients: MCPServerConnection[]
  model: string
  permissionMode: PermissionMode
  /** The command registry; user-invocable command names are emitted. */
  commands: Command[]
  /** The active agent definitions; their agent types are emitted. */
  agents: AgentDefinition[]
  /** Skills as commands; user-invocable skill names are emitted. */
  skills: Command[]
  /** The active extensions: name, folder and id. */
  extensions: Array<{ name: string; path: string; source: string }>
}

/** An invocable flag counts as invocable unless EXPLICITLY false. */
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
    // The status value is the client's TYPE field, not a connection state
    // computed here.
    mcp_servers: inputs.mcpClients.map(client => ({
      name: client.name,
      status: client.type,
    })),
    model: inputs.model,
    permissionMode: inputs.permissionMode,
    slash_commands: inputs.commands.filter(isInvocable).map(command => command.name),
    apiKeySource: getAnthropicApiKeyWithSource().source,
    // The SDK-beta list from the bootstrap owner, not the model-capability betas.
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
