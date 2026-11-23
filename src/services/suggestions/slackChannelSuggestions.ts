import { z } from 'zod'
import type { ConnectedMCPServer, MCPServerConnection } from '../../utils/mcp/types.js'
import { logForDebugging } from '../../utils/debug.js'
import { createSignal } from '../../utils/signal.js'
import { passedOver } from '../../utils/passedOver.js'


const QUERY_LIMIT = 20
const CALL_TIMEOUT_MS = 5000
const CACHE_CAP = 50
const SUGGESTION_CAP = 10

function findSlackClient(clients: MCPServerConnection[]): ConnectedMCPServer | null {
  for (const client of clients) {
    if (client.type === 'connected' && client.name.toLowerCase().includes('slack')) {
      return client
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
  let bestChannels: string[] | null = null
  for (const [key, channels] of responseCache) {
    if (!query.startsWith(key)) continue
    if (!channels.some(channel => channel.startsWith(token))) continue
    if (bestKey === null || key.length > bestKey.length) {
      bestKey = key
      bestChannels = channels
    }
  }
  return bestChannels
}

function queryPrefixFor(token: string): string {
  const lastSep = Math.max(token.lastIndexOf('-'), token.lastIndexOf('_'))
  return lastSep > 0 && lastSep < token.length - 1 ? token.slice(0, lastSep) : token
}

function normalizeChannelName(raw: string): string | null {
  const cleaned = raw.trim().replace(/^#/, '').toLowerCase()
  return /^[a-z0-9][a-z0-9_-]{0,79}$/.test(cleaned) ? cleaned : null
}

type ChannelPayload =
  | string
  | ChannelPayload[]
  | {
      name?: string
      channels?: ChannelPayload
      results?: ChannelPayload
      items?: ChannelPayload
      data?: ChannelPayload
    }
  | null

const ChannelPayloadSchema: z.ZodType<ChannelPayload> = z.lazy(() =>
  z.union([
    z.string(),
    z.array(ChannelPayloadSchema),
    z.object({
      name: z.string().optional().catch(undefined),
      channels: ChannelPayloadSchema.optional(),
      results: ChannelPayloadSchema.optional(),
      items: ChannelPayloadSchema.optional(),
      data: ChannelPayloadSchema.optional(),
    }),
    z.unknown().transform(() => null),
  ]),
)

const ToolResultSchema = z.object({
  content: z.array(
    z.union([
      z.object({ type: z.literal('text'), text: z.string() }),
      z.unknown().transform(() => null),
    ]),
  ),
})

function collectNamesFromPayload(value: ChannelPayload, out: Set<string>): void {
  if (value === null) return
  if (typeof value === 'string') {
    const name = normalizeChannelName(value)
    if (name !== null) out.add(name)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNamesFromPayload(item, out)
    return
  }
  if (value.name !== undefined) {
    const name = normalizeChannelName(value.name)
    if (name !== null) out.add(name)
  }
  if (value.channels !== undefined) collectNamesFromPayload(value.channels, out)
  if (value.results !== undefined) collectNamesFromPayload(value.results, out)
  if (value.items !== undefined) collectNamesFromPayload(value.items, out)
  if (value.data !== undefined) collectNamesFromPayload(value.data, out)
}

function parseJsonPayload(value: unknown, out: Set<string>): void {
  const parsed = ChannelPayloadSchema.safeParse(value)
  if (parsed.success) collectNamesFromPayload(parsed.data, out)
}

function parseChannelsFromToolResult(result: unknown): string[] {
  const out = new Set<string>()
  const parsedResult = ToolResultSchema.safeParse(result)
  if (parsedResult.success) {
    for (const block of parsedResult.data.content) {
      if (block === null) continue
      const text = block.text
      let parsedJson: unknown
      let isJson = false
      try {
        parsedJson = JSON.parse(text)
        isJson = true
      } catch (error) {
        passedOver(error)
      }
      if (isJson) {
        parseJsonPayload(parsedJson, out)
      } else {
        const hashPattern = /#([a-z0-9][a-z0-9_-]{0,79})/gi
        let match: RegExpExecArray | null
        while ((match = hashPattern.exec(text)) !== null) {
          const name = normalizeChannelName(match[1] ?? '')
          if (name !== null) out.add(name)
        }
      }
    }
  } else {
    parseJsonPayload(result, out)
  }
  return [...out]
}

async function fetchSlackChannels(client: ConnectedMCPServer, query: string): Promise<string[]> {
  try {
    const raw = await client.client.callTool(
      { name: 'slack_search_channels', arguments: { query, limit: QUERY_LIMIT } },
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
