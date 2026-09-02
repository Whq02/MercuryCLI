// ============================================================================
//  crew/adapters/codex — the Codex CLI inward seat profile (M3).
//
//  Protocol (verified live against codex-cli 0.144.5, — captured
//  frames in scripts/session-graph/fixtures/codex.fixture.json): the
//  app-server JSON-RPC-over-stdio surface —
//    spawn: codex app-server
//    handshake: {"jsonrpc":"2.0","id":1,"method":"initialize",
//                "params":{"clientInfo":{…}}}
//               → {"id":1,"result":{userAgent, codexHome, platformFamily,
//                  platformOs}} — no model turn.
//
//  The app-server turn surface is EXPERIMENTAL upstream (its own --help says
//  so), so this profile declares only what the handshake itself establishes:
//  structured activity (server notifications) is supported; the turn-control
// operations stay 'unknown' — the honest capability VARIANT the journey
//  requires (different declared capabilities → different action availability
//  through the same UI, never a guess).
// ============================================================================

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
  // Monotonic per-transport sequence: notifications carry no owner event id,
  // and wall-clock ms collides inside one stdout chunk — a counter never does.
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
      // Server notifications (method, no id) are the structured activity feed.
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
      // Clear the corpse so the next operation respawns instead of writing
      // into a closed stdin.
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
    // No deliver/cancelTurn: the turn surface is experimental-unnegotiated —
    // the bridge answers 'rejected: declares no delivery operation', which is
    // exactly the honest availability the capability variant journey pins.
    onEvent(listener) {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    onLifecycle(listener) {
      lifecycleListeners.add(listener)
      return () => lifecycleListeners.delete(listener)
    },
    async detach(): Promise<void> {
      // close awaits settlement (SIGTERM → grace → SIGKILL,
      // bounded) — a fire-and-forget kill left the child's fate unknown.
      const c = child
      child = null
      if (c) await (c.killAndWait?.() ?? Promise.resolve(c.kill()))
    },
  }
}
