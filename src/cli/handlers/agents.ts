// ============================================================================
//  src/cli/handlers/agents.ts — the `agents` subcommand: the agent
//  inventory, grouped by source, with shadowing and invalid-file
//  diagnostics. Writes through the console line writer; the commander
//  action exits 0 after it returns.
// ============================================================================
import { getAgentSourceDisplayName } from '../../components/agents/utils.js'
import {
  getAgentDefinitionsWithOverrides,
  type AgentDefinition,
  type AgentSource,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { getCwd } from '../../utils/cwd.js'

// The fixed source-group order for the listing.
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

/**
 * The inventory is an AUDIT surface — the one place a user checks what
 * agents a cloned repository declares — so control characters and
 * newlines from a definition never reach the terminal raw (a newline
 * name once forged a second "Built-in agents:" section; raw ANSI walked
 * straight to stdout). The loaders refuse such names now; this keeps the
 * render honest even for a definition that arrives by another road.
 * Exported for the proof suite.
 */
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
  // FC-125: the loader stamps operator overrides onto the definition as
  // operatorOverride (with its source scope), but this line tested a field
  // nothing assigns — an overridden model printed as if it were the
  // definition's own while the disabled switch from the same file WAS
  // disclosed. The provenance now reads the stamped field.
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

/** Prints the agent inventory; does not exit. */
export async function agentsHandler(): Promise<void> {
  const cwd = getCwd()
  // The loader is consulted twice — definitions, then diagnostics.
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
    // C15: a SAME-source shadow used to say only 'shadowed by <source>' —
    // its own source — naming no file, so the operator could not tell WHICH
    // copy won. A same-source winner is named by its file; a cross-source
    // winner by its source (the tier explains itself).
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
    // Invalid definitions never silently vanish — this is the same set the
    // agent studio and the health check show.
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
