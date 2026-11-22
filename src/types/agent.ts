import type { AgentOverrideProvenance } from '../services/agents/overrides.js'
import type { InstructionProfile } from '../utils/instructions/contracts.js'
import type { McpServerConfig } from '../utils/mcp/types.js'
import type { ToolUseContext } from '../Tool.js'
import type { EffortValue } from '../utils/effort.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import type { HooksSettings } from '../utils/settings/types.js'
import type { AgentColorName } from '../tools/AgentTool/agentColorManager.js'
import type { AgentMemoryScope } from '../utils/agentMemory.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

export type AgentMcpServerSpec = Unbuilt

export type AgentSource = Unbuilt

export type BuiltInAgentDefinition = Unbuilt

export type CustomAgentDefinition = Unbuilt

export type ExtensionAgentDefinition = Unbuilt

export type AgentDefinition = Unbuilt

export type AgentDefinitionsResult = Unbuilt

export function isBuiltInAgent(
  def: AgentDefinition,
): def is BuiltInAgentDefinition {
  return notBuilt('src/types/agent.ts:84')
}
