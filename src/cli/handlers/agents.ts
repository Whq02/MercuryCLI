import { getAgentSourceDisplayName } from '../../components/agents/utils.js'
import { getAgentDefinitionsWithOverrides } from '../../tools/AgentTool/loadAgentsDir.js'
import type { AgentDefinition, AgentSource } from '../../types/agent.js'
import { getCwd } from '../../utils/cwd.js'
import { notBuilt } from '../../pi/holes.js'

const SOURCE_GROUP_ORDER = [
  'built-in',
  'extension',
  'policySettings',
  'projectSettings',
  'localSettings',
  'userSettings',
  'flagSettings',
] as const

const SEPARATOR = ' · '

type RenderableAgent = {
  definition: AgentDefinition
  shadowedBy: string | undefined
}

const INVENTORY_HOSTILE = /[\x00-\x1f\x7f]/g

export function renderAgentLine(entry: RenderableAgent): string {
  const definition = entry.definition as AgentDefinition & {
    model?: string | null
    memory?: string
    disabled?: boolean
    operatorOverride?: { from?: string }
  }
  const parts: string[] = [definition.agentType]
  if (definition.model && definition.model !== 'inherit') {
    parts.push(String(definition.model))
  }
  if (definition.operatorOverride?.from) {
    parts.push(`override: ${definition.operatorOverride.from}`)
  }
  if (definition.memory) {
    parts.push(`${definition.memory} memory`)
  }
  if (definition.disabled) {
    parts.push('disabled')
  }
  const line = parts.join(SEPARATOR)
  const composed = entry.shadowedBy !== undefined
    ? `[shadowed by ${entry.shadowedBy}] ${line}`
    : line
  return composed.replace(INVENTORY_HOSTILE, '�')
}

export async function agentsHandler(): Promise<void> {
  return notBuilt('src/cli/handlers/agents.ts:52')
}
