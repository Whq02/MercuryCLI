import type { MCPServerConnection } from '../../utils/mcp/types.js'
import { logForDebugging } from '../../utils/debug.js'
import { createSignal } from '../../utils/signal.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt, unbuilt } from '../../pi/holes.js'


const QUERY_LIMIT = 20
const CALL_TIMEOUT_MS = 5000
const CACHE_CAP = 50
const SUGGESTION_CAP = 10

type ConnectedSlackClient = MCPServerConnection & {
  type: 'connected'
  client: {
    callTool: (
      params: { name: string; arguments: Record<string, unknown> },
      resultSchema?: undefined,
      options?: { timeout?: number },
    ) => Promise<unknown>
  }
}

function findSlackClient(clients: MCPServerConnection[]): ConnectedSlackClient | null {
  for (const client of clients) {
    if (client.type === 'connected' && client.name.toLowerCase().includes('slack')) {
      return client as ConnectedSlackClient
    }
  }
  return null
}

export function hasSlackMcpServer(clients: MCPServerConnection[]): boolean {
  return notBuilt('src/services/suggestions/slackChannelSuggestions.ts:33')
}

const responseCache: Map<string, string[]> = unbuilt('src/services/suggestions/slackChannelSuggestions.ts:37')
const knownChannels: Set<string> = unbuilt('src/services/suggestions/slackChannelSuggestions.ts:39')
let knownChannelsVersion: number = unbuilt('src/services/suggestions/slackChannelSuggestions.ts:40')
const knownChannelsSignal = createSignal<[]>()


function recordKnownChannels(channels: string[]): void {
  let grew = false
  for (const channel of channels) {
    if (!knownChannels.has(channel)) {
      knownChannels.add(channel)
      grew = true
    }
  }
  if (grew) {
    knownChannelsVersion++
    knownChannelsSignal.emit()
  }
}

function cachedChannelsFor(query: string, token: string): string[] | null {
  const direct = responseCache.get(query)
  if (direct !== undefined) return direct
  let bestKey: string | null = null
  for (const key of responseCache.keys()) {
    if (!query.startsWith(key)) continue
    const channels = responseCache.get(key) as string[]
    if (!channels.some(channel => channel.startsWith(token))) continue
    if (bestKey === null || key.length > bestKey.length) bestKey = key
  }
  return bestKey !== null ? (responseCache.get(bestKey) as string[]) : null
}

export async function getSlackChannelSuggestions(
  clients: MCPServerConnection[],
  searchToken: string,
): Promise<Array<{ id: string; displayText: string }>> {
  return notBuilt('src/services/suggestions/slackChannelSuggestions.ts:137')
}

export function findSlackChannelPositions(text: string): Array<{ start: number; end: number }> {
  return notBuilt('src/services/suggestions/slackChannelSuggestions.ts:154')
}
