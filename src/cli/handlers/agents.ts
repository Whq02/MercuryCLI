import { getAgentSourceDisplayName } from '../../components/agents/utils.js'
import { getAgentDefinitionsWithOverrides } from '../../tools/AgentTool/loadAgentsDir.js'
import type { AgentDefinition, AgentSource } from '../../types/agent.js'
import { getCwd } from '../../utils/cwd.js'

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

function winnerLabel(winner: AgentDefinition, shadowed: AgentDefinition): string {
  if (winner.source === shadowed.source) {
    if (winner.source !== 'built-in' && winner.source !== 'extension' && winner.filePath) {
      return winner.filePath
    }
    if (winner.filename) {
      return `${winner.filename}.md`
    }
  }
  return getAgentSourceDisplayName(winner.source)
}

export async function agentsHandler(): Promise<void> {
  const { activeAgents, allAgents, failedFiles } = await getAgentDefinitionsWithOverrides(getCwd())
  const failed = failedFiles ?? []
  if (allAgents.length === 0 && failed.length === 0) {
    console.log('No agents found')
    return
  }

  const activeByType = new Map<string, AgentDefinition>()
  for (const agent of activeAgents) {
    activeByType.set(agent.agentType, agent)
  }

  const bySource = new Map<AgentSource, RenderableAgent[]>()
  for (const definition of allAgents) {
    const winner = activeByType.get(definition.agentType)
    const shadowedBy =
      winner !== undefined && winner !== definition
        ? winnerLabel(winner, definition)
        : undefined
    const list = bySource.get(definition.source)
    if (list) {
      list.push({ definition, shadowedBy })
    } else {
      bySource.set(definition.source, [{ definition, shadowedBy }])
    }
  }

  const standardSources = new Set<AgentSource>(SOURCE_GROUP_ORDER)
  const orderedSources: AgentSource[] = [
    ...SOURCE_GROUP_ORDER,
    ...[...bySource.keys()].filter(source => !standardSources.has(source)),
  ]

  const count = activeAgents.length
  const lines: string[] = [`${count} active ${count === 1 ? 'agent' : 'agents'}`]

  for (const source of orderedSources) {
    const group = bySource.get(source)
    if (!group || group.length === 0) continue
    group.sort((a, b) => a.definition.agentType.localeCompare(b.definition.agentType))
    lines.push('')
    lines.push(`${getAgentSourceDisplayName(source)}:`)
    for (const entry of group) {
      lines.push(`  ${renderAgentLine(entry)}`)
    }
  }

  if (failed.length > 0) {
    lines.push('')
    lines.push('Invalid agent definition files:')
    for (const file of failed) {
      lines.push(`  ${file.path}: ${file.error}`)
    }
  }

  console.log(lines.join('\n'))
}
