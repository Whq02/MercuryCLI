import Fuse from 'fuse.js'
import type { AgentDefinition } from '../types/agent.js'
import { generateFileSuggestions } from './fileSuggestions.js'
import { truncateToWidth } from '../utils/glyphs.js'
import { logForDebugging } from '../utils/debug.js'
import { isRecord } from '../utils/isRecord.js'
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
    const needle = query.toLowerCase()
    const out: Array<{ item: SuggestionItem; agentType: string; description: string }> = []
    for (const agent of agents) {
      const displayText = `${agent.agentType} (agent)`
      if (
        !(query === '' && showOnEmpty) &&
        !agent.agentType.toLowerCase().includes(needle) &&
        !displayText.toLowerCase().includes(needle)
      ) {
        continue
      }
      const description = truncateToWidth(agent.whenToUse ?? '', DESCRIPTION_WIDTH)
      out.push({
        item: {
          id: `agent-${agent.agentType}`,
          displayText,
          description,
          ...(agent.color !== undefined ? { color: agent.color } : {}),
        },
        agentType: agent.agentType,
        description,
      })
    }
    return out
  } catch (error) {
    logForDebugging(`Failed to build agent suggestions: ${String(error)}`)
    return []
  }
}

function fileScore(item: SuggestionItem): number {
  const metadata = item.metadata
  if (isRecord(metadata) && typeof metadata.score === 'number') {
    return metadata.score
  }
  return MID_SCORE
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
    return [
      ...files,
      ...resources.map(entry => entry.item),
      ...agentEntries.map(entry => entry.item),
    ].slice(0, RESULT_CAP)
  }

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
  const agentFuse = new Fuse(agentEntries, {
    includeScore: true,
    threshold: FUZZY_THRESHOLD,
    keys: [
      { name: 'agentType', weight: 3 },
      { name: 'item.displayText', weight: 2 },
      { name: 'description', weight: 1 },
    ],
  })

  const scored: Scored[] = [
    ...files.map(item => ({ item, score: fileScore(item) })),
    ...resourceFuse.search(query).map(result => ({
      item: result.item.item,
      score: result.score ?? MID_SCORE,
    })),
    ...agentFuse.search(query).map(result => ({
      item: result.item.item,
      score: result.score ?? MID_SCORE,
    })),
  ]
  scored.sort((a, b) => a.score - b.score)
  return scored.slice(0, RESULT_CAP).map(entry => entry.item)
}
