import Fuse from 'fuse.js'
import type { AgentDefinition } from '../types/agent.js'
import { generateFileSuggestions } from './fileSuggestions.js'
import { truncateToWidth } from '../utils/glyphs.js'
import { logForDebugging } from '../utils/debug.js'
import type { SuggestionItem } from '../components/PromptInput/PromptInputFooterSuggestions.js'
import { notBuilt } from '../pi/holes.js'

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

export async function generateUnifiedSuggestions(
  query: string,
  mcpResources: Record<string, McpResource[]>,
  agents: AgentDefinition[],
  showOnEmpty?: boolean,
): Promise<SuggestionItem[]> {
  return notBuilt('src/hooks/unifiedSuggestions.ts:92')
}
