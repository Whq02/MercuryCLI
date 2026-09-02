import { getAgentSourceDisplayName } from '../../components/agents/utils.js'
import {
  getAgentDefinitionsWithOverrides,
  type AgentDefinition,
  type AgentSource,
} from '../../tools/AgentTool/loadAgentsDir.js'
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

// eslint-disable-next-line no-control-regex
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
  const cwd = getCwd()
  const definitions = await getAgentDefinitionsWithOverrides(cwd)
  const diagnostics = await getAgentDefinitionsWithOverrides(cwd)
  const failedFiles = diagnostics.failedFiles ?? []

  const activeByType = new Map<string, AgentDefinition>()
  for (const agent of definitions.activeAgents) {
    activeByType.set(agent.agentType, agent)
  }

  const byGroup = new Map<AgentSource, RenderableAgent[]>()
  for (const agent of definitions.allAgents) {
    const winner = activeByType.get(agent.agentType)
    const shadowedBy =
      winner && winner !== agent
        ? winner.source === agent.source
          ? ((winner as { filePath?: string }).filePath ??
            (winner.filename !== undefined ? `${winner.filename}.md` : getAgentSourceDisplayName(winner.source)))
          : getAgentSourceDisplayName(winner.source)
        : undefined
    const group = agent.source
    const bucket = byGroup.get(group) ?? []
    bucket.push({ definition: agent, shadowedBy })
    byGroup.set(group, bucket)
  }

  const lines: string[] = []
  const groupOrder: AgentSource[] = [
    ...SOURCE_GROUP_ORDER.filter(group => byGroup.has(group)),
    ...[...byGroup.keys()].filter(
      group => !(SOURCE_GROUP_ORDER as readonly AgentSource[]).includes(group),
    ),
  ]
  for (const group of groupOrder) {
    const bucket = byGroup.get(group)
    if (!bucket || bucket.length === 0) continue
    lines.push(`${getAgentSourceDisplayName(group)}:`)
    for (const entry of [...bucket].sort((a, b) =>
      a.definition.agentType.localeCompare(b.definition.agentType),
    )) {
      lines.push(`  ${renderAgentLine(entry)}`)
    }
    lines.push('')
  }

  if (failedFiles.length > 0) {
    lines.push('Invalid agent definition files:')
    for (const failed of failedFiles) {
      lines.push(`  ${failed.path}: ${failed.error}`)
    }
    lines.push('')
  }

  if (lines.length === 0) {
    console.log('No agents found')
    return
  }

  const activeCount = definitions.activeAgents.length
  console.log(`${activeCount} active agent${activeCount === 1 ? '' : 's'}`)
  console.log('')
  console.log(lines.join('\n').trimEnd())
}
