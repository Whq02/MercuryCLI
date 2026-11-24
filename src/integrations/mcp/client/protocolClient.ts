import { Client, StdioClientTransport, ProtocolErrorCode } from '../../mcp-shapes/sdk.js'
import { pathToFileURL } from 'node:url'
import { getOriginalCwd } from '../../../boot/process-state/processState.js'
import { flagEnabled } from '../../../platform/substrate/flagRegistry.js'
import { getCwd } from '../../../platform/files/cwd.js'
import { logMCPDebug } from '../../../platform/logs/errorLog.js'
import { platformTempRoots } from '../../../platform/host-os/files.js'
import { RESPONSE_STREAM_ENDED } from './errors.js'
import { connectTimeoutMs } from './limits.js'
import { startTimeout } from '../../../platform/async/timers.js'

function clientVersion(): string {
  return typeof MACRO !== 'undefined' ? (MACRO.VERSION ?? 'unknown') : 'unknown'
}

type ProbeTransportKind = 'stdio' | 'remote'

export class OwnedStdioClientTransport extends StdioClientTransport {}

function externalVersionNegotiation(transportKind: ProbeTransportKind): { mode: 'auto'; probe: { timeoutMs: number; maxRetries: number } } {
  const deadline = connectTimeoutMs()
  const timeoutMs = transportKind === 'stdio' ? Math.max(1000, Math.floor(deadline / 3)) : deadline + 1000
  return { mode: 'auto', probe: { timeoutMs, maxRetries: 0 } }
}

type ListChangedKind = 'tools' | 'prompts' | 'resources'
const listChangedListeners = new WeakMap<Client, Partial<Record<ListChangedKind, () => void>>>()

export function onMcpListChanged(client: Client, kind: ListChangedKind, listener: () => void): void {
  const slots = listChangedListeners.get(client) ?? {}
  slots[kind] = listener
  listChangedListeners.set(client, slots)
}

function listChangedHandlers(lookup: () => Client | undefined): {
  tools: { autoRefresh: false; onChanged: () => void }
  prompts: { autoRefresh: false; onChanged: () => void }
  resources: { autoRefresh: false; onChanged: () => void }
} {
  const signal =
    (kind: ListChangedKind) => (): void => {
      const client = lookup()
      if (client === undefined) return
      listChangedListeners.get(client)?.[kind]?.()
    }
  return {
    tools: { autoRefresh: false, onChanged: signal('tools') },
    prompts: { autoRefresh: false, onChanged: signal('prompts') },
    resources: { autoRefresh: false, onChanged: signal('resources') },
  }
}

const TOOL_REQUIRED_FIELDS = new Set(['name', 'inputSchema'])

function withoutNullKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, inner]) => inner !== null))
}

function withoutNullToolMetadata(tool: unknown): unknown {
  if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) return tool
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(tool as Record<string, unknown>)) {
    if (value === null && !TOOL_REQUIRED_FIELDS.has(key)) continue
    out[key] = key === 'inputSchema' || key === 'annotations' ? withoutNullKeys(value) : value
  }
  return out
}

class ToolListClient extends Client {
  override async connect(...args: Parameters<Client['connect']>): Promise<void> {
    const [transport] = args
    const requests = new Set<string | number>()
    const awaiting = new Set<string | number>()
    const send = transport.send.bind(transport)
    transport.send = (message, options) => {
      if (!('method' in message) || !('id' in message) || message.id === undefined) return send(message, options)
      const id = message.id
      if (message.method === 'tools/list') requests.add(id)
      awaiting.add(id)
      const onRequestStreamEnd = (): void => {
        options?.onRequestStreamEnd?.()
        if (!awaiting.has(id)) return
        startTimeout(() => {
          if (!awaiting.delete(id)) return
          transport.onmessage?.({
            jsonrpc: '2.0',
            id,
            error: { code: ProtocolErrorCode.InternalError, message: 'the server closed the response stream before answering', data: { reason: RESPONSE_STREAM_ENDED } },
          })
        }, 0)
      }
      return send(message, { ...options, onRequestStreamEnd })
    }
    const onmessage = transport.onmessage
    transport.onmessage = (message, extra) => {
      if ('id' in message && message.id !== undefined && ('result' in message || 'error' in message)) awaiting.delete(message.id)
      if ('id' in message && message.id !== undefined && requests.delete(message.id) && 'result' in message) {
        const result = message.result
        if (Array.isArray(result.tools) && this._wireCodec().validateResult('tools/list', { ...result, tools: [] }).ok) {
          result.tools = result.tools.map(withoutNullToolMetadata).filter((tool: unknown) => {
            const checked = this._wireCodec().validateResult('tools/list', { ...result, tools: [tool] })
            if (checked.ok) return true
            logMCPDebug(this.getServerVersion()?.name ?? 'MCP', `skipping malformed tool: ${checked.reason === 'invalid' ? checked.message : checked.reason}`)
            return false
          })
        }
      }
      onmessage?.(message, extra)
    }
    return super.connect(...args)
  }
}

export function buildClient(negotiate: boolean, transportKind: ProbeTransportKind = 'remote'): Client {
  let built: Client | undefined
  built = new ToolListClient(
    {
      name: 'mercury',
      title: 'Mercury',
      version: clientVersion(),
      description: 'Mercury, an agentic coding harness',
    },
    {
      capabilities: { roots: {}, elicitation: { form: {}, url: {} } },
      versionNegotiation: negotiate ? externalVersionNegotiation(transportKind) : { mode: 'legacy' },
      listChanged: listChangedHandlers(() => built),
    },
  )
  return built
}

export function installRootsHandler(client: Client): void {
  client.setRequestHandler('roots/list', async () => {
    const roots = [pathToFileURL(getOriginalCwd()).href]
    const add = (p: string): void => {
      const stripped = p.replace(/[\\/]+$/, '')
      const uri = pathToFileURL(stripped || p).href
      if (!roots.includes(uri)) roots.push(uri)
    }
    if (flagEnabled('MERCURY_MCP_ROOTS_WIDE')) {
      add(getCwd())
      for (const root of platformTempRoots(true)) add(root)
    }
    return { roots: roots.map(uri => ({ uri })) }
  })
}
