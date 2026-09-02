
import { randomUUID } from 'node:crypto'
import type { CapabilityKind, CapabilityState } from '../capabilities.js'
import type {
  ExternalSeatTransport,
  SeatEvent,
  SeatHandshakeResult,
} from '../seatBridge.js'
import { awaitLine, realNdjsonChild, type NdjsonChildLike, type SpawnImpl } from './ndjsonChild.js'

const HANDSHAKE_TIMEOUT_MS = 20_000

export function codexDeclaredCapabilities(): Partial<
  Record<CapabilityKind, { state: CapabilityState; source: string }>
> {
  return {
    'structured-activity': { state: 'supported', source: 'profile:app-server notifications' },
    'steer-current': { state: 'unsupported', source: 'profile:no mid-turn injection method' },
    'start-turn': { state: 'unknown', source: 'profile:app-server turn surface is experimental — unnegotiated' },
    'hold-next': { state: 'unknown', source: 'profile:app-server turn surface is experimental — unnegotiated' },
    'cancel-turn': { state: 'unknown', source: 'profile:app-server turn surface is experimental — unnegotiated' },
    'attach-file': { state: 'unknown', source: 'profile:unnegotiated' },
    'attach-image': { state: 'unknown', source: 'profile:unnegotiated' },
    'attach-selection': { state: 'unsupported', source: 'profile:no selection vocabulary' },
    'resume-session': { state: 'unknown', source: 'profile:CLI resume exists; app-server resume unnegotiated' },
    'set-title': { state: 'unsupported', source: 'profile:no title operation' },
    'usage-totals': { state: 'unknown', source: 'profile:unnegotiated' },
    'artifact-replies': { state: 'unsupported', source: 'profile:no artifact-thread vocabulary' },
  }
}

export interface CodexSeatOptions {
  cwd?: string
  spawnImpl?: SpawnImpl
}

export function codexSeatTransport(opts: CodexSeatOptions = {}): ExternalSeatTransport {
  let child: NdjsonChildLike | null = null
  const eventListeners = new Set<(evt: SeatEvent) => void>()
  const lifecycleListeners = new Set<(s: 'connected' | 'disconnected' | 'exited') => void>()
  let eventSeq = 0

  const ensureChild = (): NdjsonChildLike => {
    if (child) return child
    const spawnImpl = opts.spawnImpl ?? realNdjsonChild
    const c = spawnImpl('codex', ['app-server'], { cwd: opts.cwd })
    child = c
    c.onLine(line => {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      if (typeof parsed.method === 'string' && parsed.id === undefined) {
        const evt: SeatEvent = {
          sourceEventId: `${parsed.method}-${++eventSeq}`,
          kind: parsed.method,
          payload: parsed.params ?? null,
          atMs: Date.now(),
        }
        for (const l of [...eventListeners]) l(evt)
      }
    })
    c.onExit(() => {
      if (child === c) child = null
      for (const l of [...lifecycleListeners]) l('exited')
    })
    return c
  }

  return {
    adapterKind: 'codex',
    displayName: 'Codex',
    mercuryOwnsProcess: true,
    async handshake(): Promise<SeatHandshakeResult> {
      const c = ensureChild()
      const id = Math.floor(Math.random() * 1_000_000) + 1
      const answer = awaitLine(
        c,
        p => typeof p === 'object' && p !== null && (p as Record<string, unknown>).id === id,
        HANDSHAKE_TIMEOUT_MS,
      )
      c.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'initialize',
          params: {
            clientInfo: { name: 'mercury', title: 'Mercury', version: '1.0' },
            requestId: randomUUID(),
          },
        }),
      )
      const result = await answer
      if (!result.ok) throw new Error(`codex handshake failed: ${result.reason}`)
      const body = result.parsed as { result?: { userAgent?: string }; error?: { message?: string } }
      if (body.error) throw new Error(`codex handshake refused: ${body.error.message}`)
      return {
        protocol: 'codex-app-server@jsonrpc-initialize',
        revision: body.result?.userAgent ?? 'unknown-revision',
        declared: codexDeclaredCapabilities(),
        raw: { userAgent: body.result?.userAgent },
      }
    },
    onEvent(listener) {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    onLifecycle(listener) {
      lifecycleListeners.add(listener)
      return () => lifecycleListeners.delete(listener)
    },
    async detach(): Promise<void> {
      const c = child
      child = null
      if (c) await (c.killAndWait?.() ?? Promise.resolve(c.kill()))
    },
  }
}
