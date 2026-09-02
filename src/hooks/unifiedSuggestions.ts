// One ranked completion list: files (pre-scored by the index, lower
// is better), MCP resources (server:uri), and agents — merged, fuzzy-scored
// with weighted fields at a permissive 0.6 threshold (ranking, not
// filtering, does the work), sorted ascending, capped at 15. Identifiers
// are namespaced per source: `file-`, `mcp-resource-` (server__uri), and
// `agent-` (contract data).

import Fuse from 'fuse.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { generateFileSuggestions } from './fileSuggestions.js'
import { truncateToWidth } from '../components/mercury-ui/glyphs.js'
import { logForDebugging } from '../utils/debug.js'
import type { SuggestionItem } from '../components/PromptInput/PromptInputFooterSuggestions.js'

const RESULT_CAP = 15
const DESCRIPTION_WIDTH = 60
const FUZZY_THRESHOLD = 0.6
const MID_SCORE = 0.5

type McpResource = {
  uri: string
  name?: string
  description?: string
}

type Scored = { item: SuggestionItem; score: number }

function resourceItems(
  resources: Record<string, McpResource[]>,
): Array<{ item: SuggestionItem; name: string; server: string; description: string }> {
  const out: Array<{
    item: SuggestionItem
    name: string
    server: string
    description: string
  }> = []
  for (const [server, list] of Object.entries(resources)) {
    for (const resource of list ?? []) {
      const description = truncateToWidth(
        resource.description ?? resource.name ?? resource.uri,
        DESCRIPTION_WIDTH,
      )
      out.push({
        item: {
          id: `mcp-resource-${server}__${resource.uri}`,
          displayText: `${server}:${resource.uri}`,
          description,
        },
        name: resource.name ?? '',
        server,
        description,
      })
    }
  }
  return out
}

function agentItems(
  agents: AgentDefinition[],
  query: string,
  showOnEmpty: boolean,
): Array<{ item: SuggestionItem; agentType: string; description: string }> {
  try {
    const filtered =
      query === ''
        ? showOnEmpty
          ? agents
          : []
        : agents.filter(agent => {
            const needle = query.toLowerCase()
            return (
              agent.agentType.toLowerCase().includes(needle) ||
              `${agent.agentType} (agent)`.toLowerCase().includes(needle)
            )
          })
    return filtered.map(agent => {
      const description = truncateToWidth(
        (agent as { whenToUse?: string }).whenToUse ?? '',
        DESCRIPTION_WIDTH,
      )
      return {
        item: {
          id: `agent-${agent.agentType}`,
          displayText: `${agent.agentType} (agent)`,
          description,
          color: (agent as { color?: string }).color,
        },
        agentType: agent.agentType,
        description,
      }
    })
  } catch (error) {
    logForDebugging(`agent suggestions failed: ${error}`)
    return []
  }
}

export async function generateUnifiedSuggestions(
  query: string,
  mcpResources: Record<string, McpResource[]>,
  agents: AgentDefinition[],
  showOnEmpty?: boolean,
): Promise<SuggestionItem[]> {
  if (query === '' && showOnEmpty !== true) return []

  const files = await generateFileSuggestions(query, showOnEmpty)
  const resources = resourceItems(mcpResources)
  const agentEntries = agentItems(agents, query, showOnEmpty === true)

  if (query === '') {
    // file → resource → agent order, truncated.
    return [
      ...files,
      ...resources.map(entry => entry.item),
      ...agentEntries.map(entry => entry.item),
    ].slice(0, RESULT_CAP)
  }

  const scored: Scored[] = files.map(item => ({
    item,
    score:
      typeof (item.metadata as { score?: number } | undefined)?.score === 'number'
        ? ((item.metadata as { score: number }).score)
        : MID_SCORE,
  }))

  const resourceFuse = new Fuse(resources, {
    includeScore: true,
    threshold: FUZZY_THRESHOLD,
    keys: [
      { name: 'name', weight: 3 },
      { name: 'item.displayText', weight: 2 },
      { name: 'server', weight: 1 },
      { name: 'description', weight: 1 },
    ],
  })
  for (const result of resourceFuse.search(query, { limit: RESULT_CAP })) {
    scored.push({ item: result.item.item, score: result.score ?? MID_SCORE })
  }

  const agentFuse = new Fuse(agentEntries, {
    includeScore: true,
    threshold: FUZZY_THRESHOLD,
    keys: [
      { name: 'agentType', weight: 3 },
      { name: 'item.displayText', weight: 2 },
      { name: 'description', weight: 1 },
    ],
  })
  for (const result of agentFuse.search(query, { limit: RESULT_CAP })) {
    scored.push({ item: result.item.item, score: result.score ?? MID_SCORE })
  }

  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, RESULT_CAP)
    .map(entry => entry.item)
}
