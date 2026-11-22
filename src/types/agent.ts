import type { AgentOverrideProvenance } from '../services/agents/overrides.js'
import type { InstructionProfile } from '../utils/instructions/contracts.js'
import type { McpServerConfig } from '../utils/mcp/types.js'
import type { ToolUseContext } from '../Tool.js'
import type { EffortValue } from '../utils/effort.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import type { HooksSettings } from '../utils/settings/types.js'
import type { AgentColorName } from '../tools/AgentTool/agentColorManager.js'
import type { AgentMemoryScope } from '../utils/agentMemory.js'

export type AgentMcpServerSpec = string | { [name: string]: McpServerConfig }

export type AgentSource =
  | 'built-in'
  | 'extension'
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'policySettings'
  | 'flagSettings'

type BaseAgentDefinition = {
  agentType: string
  whenToUse: string
  tools?: string[]
  disallowedTools?: string[]
  skills?: string[]
  mcpServers?: AgentMcpServerSpec[]
  hooks?: HooksSettings
  color?: AgentColorName
  model?: string
  effort?: EffortValue
  instructionProfile?: InstructionProfile
  permissionMode?: PermissionMode
  maxTurns?: number
  filename?: string
  baseDir?: string
  standingRule?: string
  requiredMcpServers?: string[]
  background?: boolean
  initialPrompt?: string
  memory?: AgentMemoryScope
  isolation?: 'worktree' | 'remote'
  omitProjectInstructions?: boolean
  fixedOutputContract?: boolean
  operatorOverride?: AgentOverrideProvenance
  disabled?: boolean
}

export type BuiltInAgentDefinition = BaseAgentDefinition & {
  source: 'built-in'
  baseDir: string
  callback?: () => void | Promise<void>
  getSystemPrompt: (params: {
    toolUseContext: Pick<ToolUseContext, 'options'>
  }) => string
}

export type CustomAgentDefinition = BaseAgentDefinition & {
  getSystemPrompt: () => string
  source: Exclude<AgentSource, 'built-in' | 'extension'>
  filePath?: string
  revision?: string
}

export type ExtensionAgentDefinition = BaseAgentDefinition & {
  getSystemPrompt: () => string
  source: 'extension'
  extensionName?: string
}

export type AgentDefinition =
  | BuiltInAgentDefinition
  | CustomAgentDefinition
  | ExtensionAgentDefinition

export type AgentDefinitionsResult = {
  activeAgents: AgentDefinition[]
  allAgents: AgentDefinition[]
  failedFiles?: Array<{ path: string; error: string }>
  allowedAgentTypes?: string[]
}

export function isBuiltInAgent(
  def: AgentDefinition,
): def is BuiltInAgentDefinition {
  return def.source === 'built-in'
}
