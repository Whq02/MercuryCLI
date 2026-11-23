import type { MCPServerConnection } from '../../utils/mcp/types.js'
import { logForDebugging } from '../../utils/debug.js'
import { createSignal } from '../../utils/signal.js'
import { passedOver } from '../../utils/passedOver.js'


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
  return findSlackClient(clients) !== null
}

const responseCache: Map<string, string[]> = new Map()
const knownChannels: Set<string> = new Set()
let knownChannelsVersion = 0
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

function queryPrefixFor(token: string): string {
  const lastSep = Math.max(token.lastIndexOf('-'), token.lastIndexOf('_'))
  return lastSep > 0 && lastSep < token.length - 1 ? token.slice(0, lastSep) : token
}

function normalizeChannelName(raw: string): string | null {
  const cleaned = raw.trim().replace(/^#/, '').toLowerCase()
  return /^[a-z0-9][a-z0-9_-]{0,79}$/.test(cleaned) ? cleaned : null
}

function collectNamesFromJson(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    const name = normalizeChannelName(value)
    if (name !== null) out.add(name)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNamesFromJson(item, out)
    return
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.name === 'string') {
      const name = normalizeChannelName(record.name)
      if (name !== null) out.add(name)
    }
    for (const key of ['channels', 'results', 'items', 'data'] as const) {
      if (record[key] !== undefined) collectNamesFromJson(record[key], out)
    }
  }
}

function parseChannelsFromToolResult(result: unknown): string[] {
  const out = new Set<string>()
  if (!result || typeof result !== 'object') return []
  const content = (result as { content?: unknown }).content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const text = (block as { text?: unknown }).text
      if (typeof text !== 'string') continue
      let parsedJson = false
      try {
        const parsed: unknown = JSON.parse(text)
        collectNamesFromJson(parsed, out)
        parsedJson = true
      } catch (error) {
        passedOver(error)
      }
      if (!parsedJson) {
        const hashPattern = /#([a-z0-9][a-z0-9_-]{0,79})/gi
        let match: RegExpExecArray | null
        while ((match = hashPattern.exec(text)) !== null) {
          const name = normalizeChannelName(match[1] ?? '')
          if (name !== null) out.add(name)
        }
      }
    }
  } else {
    collectNamesFromJson(result, out)
  }
  return [...out]
}

async function fetchSlackChannels(client: ConnectedSlackClient, query: string): Promise<string[]> {
  try {
    const raw = await client.client.callTool(
      { name: 'slack_search_channels', arguments: { query, limit: QUERY_LIMIT } },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    )
    const channels = parseChannelsFromToolResult(raw)
    if (responseCache.size >= CACHE_CAP && !responseCache.has(query)) {
      const oldest = responseCache.keys().next().value
      if (oldest !== undefined) responseCache.delete(oldest)
    }
    responseCache.set(query, channels)
    recordKnownChannels(channels)
    return channels
  } catch (error) {
    logForDebugging(`slack channel suggestions fetch failed for "${query}": ${String(error)}`, { level: 'warn' })
    passedOver(error)
    return []
  }
}

export async function getSlackChannelSuggestions(
  clients: MCPServerConnection[],
  searchToken: string,
): Promise<Array<{ id: string; displayText: string }>> {
  const token = searchToken.toLowerCase()
  if (token === '') return []
  const client = findSlackClient(clients)
  if (!client) return []

  const query = queryPrefixFor(token)
  const cached = cachedChannelsFor(query, token)
  const fetched = cached !== null ? cached : await fetchSlackChannels(client, query)

  const candidates = new Set<string>(fetched)
  for (const known of knownChannels) {
    candidates.add(known)
  }

  return [...candidates]
    .filter(name => name.startsWith(token))
    .sort()
    .slice(0, SUGGESTION_CAP)
    .map(name => ({
      id: `slack-channel-${name}`,
      displayText: `#${name}`,
    }))
}

export function findSlackChannelPositions(text: string): Array<{ start: number; end: number }> {
  if (knownChannels.size === 0 || !text.includes('#')) return []
  const positions: Array<{ start: number; end: number }> = []
  const pattern = /(^|\s)(#([a-z0-9][a-z0-9_-]{0,79}))(?=$|\s)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const name = match[3]
    if (name !== undefined && knownChannels.has(name)) {
      const start = match.index + (match[1]?.length ?? 0)
      const end = start + (match[2]?.length ?? 0)
      positions.push({ start, end })
    }
  }
  return positions
}
