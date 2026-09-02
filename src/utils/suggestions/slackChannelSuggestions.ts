import type { MCPServerConnection } from '../../services/mcp/types.js'
import { logForDebugging } from '../debug.js'
import { createSignal } from '../signal.js'

/**
 * `#channel` typeahead backed by a connected Slack MCP server, via its
 * `slack_search_channels` tool. The response formats (the `Name: #channel`
 * markdown and the `{"results": "..."}` envelope) are another vendor's
 * contract — tolerated, not designed; a format change degrades silently to
 * no suggestions.
 */

const QUERY_LIMIT = 20
const CALL_TIMEOUT_MS = 5000
const CACHE_CAP = 50
const SUGGESTION_CAP = 10
const CHANNEL_NAME_PATTERN = /^Name:\s*#?([a-z0-9][a-z0-9_-]{0,79})\s*$/

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
  return findSlackClient(clients) !== null
}

// Cache keyed by the query AS SENT; bounded, insertion-order eviction.
const responseCache = new Map<string, string[]>()
const inFlight = new Map<string, Promise<string[]>>()
const knownChannels = new Set<string>()
let knownChannelsVersion = 0
const knownChannelsSignal = createSignal<[]>()

/** Monotonic within a run of the cache (a clear resets it to zero). */
export function getKnownChannelsVersion(): number {
  return knownChannelsVersion
}

export function subscribeKnownChannels(listener: () => void): () => void {
  return knownChannelsSignal.subscribe(listener)
}

function recordKnownChannels(channels: string[]): void {
  // The version advances only when the set actually GREW — a response with
  // nothing new is silent, so subscribers do not re-render per keystroke.
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

function parseChannelsFromResponse(raw: unknown): string[] {
  const content = (raw as { content?: Array<{ type?: string; text?: string }> })?.content
  if (!Array.isArray(content)) return []
  let text = content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
  // The server sometimes wraps its markdown in a JSON envelope with a
  // single string field named `results`.
  if (text.trimStart().startsWith('{')) {
    try {
      const envelope = JSON.parse(text) as { results?: unknown }
      if (typeof envelope.results === 'string') text = envelope.results
    } catch {
      // Not the envelope; use the text as-is.
    }
  }
  const channels: string[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    const match = line.trim().match(CHANNEL_NAME_PATTERN)
    if (!match) continue
    const name = match[1] as string
    if (seen.has(name)) continue
    seen.add(name)
    channels.push(name)
  }
  return channels
}

/**
 * Slack's search tokenises on hyphens and needs whole words, so a trailing
 * partial segment kills it: the query sent is the token truncated at its
 * last `-`/`_` (when not at position 0); local filtering narrows to the
 * full token.
 */
function mcpQueryFor(searchToken: string): string {
  const lastSeparator = Math.max(searchToken.lastIndexOf('-'), searchToken.lastIndexOf('_'))
  if (lastSeparator > 0) return searchToken.slice(0, lastSeparator)
  return searchToken
}

async function fetchChannels(client: ConnectedSlackClient, query: string): Promise<string[]> {
  const existing = inFlight.get(query)
  // Concurrent requests share one in-flight promise; only the request that
  // STARTED the fetch caches, records and evicts.
  if (existing !== undefined) return existing
  const fetchPromise = (async () => {
    try {
      const response = await client.client.callTool(
        {
          name: 'slack_search_channels',
          arguments: { query, limit: QUERY_LIMIT, channel_types: 'public_channel,private_channel' },
        },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )
      const channels = parseChannelsFromResponse(response)
      responseCache.set(query, channels)
      recordKnownChannels(channels)
      while (responseCache.size > CACHE_CAP) {
        const oldest = responseCache.keys().next().value as string
        responseCache.delete(oldest)
      }
      return channels
    } catch (error) {
      logForDebugging(`slack channel search failed: ${String(error)}`)
      return []
    } finally {
      inFlight.delete(query)
    }
  })()
  inFlight.set(query, fetchPromise)
  return fetchPromise
}

/**
 * A lookup also accepts a cached entry whose key is a PREFIX of the
 * current query and still contains a match for the token — choosing the
 * longest such key — so c → cl → cla reuses one fetch.
 */
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
  const token = searchToken.toLowerCase()
  if (token === '') return []
  const client = findSlackClient(clients)
  if (client === null) return []
  const query = mcpQueryFor(token)
  const channels = cachedChannelsFor(query, token) ?? (await fetchChannels(client, query))
  return channels
    .filter(channel => channel.startsWith(token))
    .sort()
    .slice(0, SUGGESTION_CAP)
    .map(channel => ({ id: `slack-channel-${channel}`, displayText: `#${channel}` }))
}

/**
 * `#name` tokens at the start or after whitespace, followed by whitespace
 * or end, highlighted ONLY when the name is in the known set — confirmed
 * real channels only. Positions include the `#`.
 */
export function findSlackChannelPositions(text: string): Array<{ start: number; end: number }> {
  const positions: Array<{ start: number; end: number }> = []
  const pattern = /(^|\s)(#([a-z0-9][a-z0-9_-]{0,79}))(?=\s|$)/g
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue
    if (!knownChannels.has(match[3] as string)) continue
    const start = match.index + (match[1] as string).length
    positions.push({ start, end: start + (match[2] as string).length })
  }
  return positions
}

/** Resets the cache, the known set, the version and any in-flight state. */
export function clearSlackChannelCache(): void {
  responseCache.clear()
  inFlight.clear()
  knownChannels.clear()
  knownChannelsVersion = 0
}
