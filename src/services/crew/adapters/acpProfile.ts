
import type { CapabilityKind, CapabilityState } from '../capabilities.js'
import type {
  ExternalSeatTransport,
  SeatEvent,
  SeatHandshakeResult,
} from '../seatBridge.js'
import { awaitLine, realNdjsonChild, type NdjsonChildLike, type SpawnImpl } from './ndjsonChild.js'

const HANDSHAKE_TIMEOUT_MS = 20_000

interface AcpInitializeResult {
  protocolVersion?: number | string
  agentInfo?: { name?: string; version?: string }
  agentCapabilities?: {
    loadSession?: boolean
    promptCapabilities?: { image?: boolean; embeddedContext?: boolean }
  }
}

export function acpDeclaredCapabilities(
  init: AcpInitializeResult,
): Partial<Record<CapabilityKind, { state: CapabilityState; source: string }>> {
  const caps = init.agentCapabilities ?? {}
  const prompt = caps.promptCapabilities ?? {}
  return {
    'start-turn': { state: 'unknown', source: 'acp:session/prompt exists in v1 — not yet implemented by this transport' },
    'hold-next': { state: 'unknown', source: 'acp:no queued-delivery vocabulary — Mercury-local holds are a separate fact' },
    'steer-current': { state: 'unsupported', source: 'acp:no mid-turn injection method in v1' },
    'cancel-turn': { state: 'unknown', source: 'acp:session/cancel exists in v1 — not yet implemented by this transport' },
    'attach-file': { state: 'supported', source: 'acp:resource_link content' },
    'attach-image': {
      state: prompt.image === true ? 'supported' : 'unsupported',
      source: `acp:promptCapabilities.image=${String(prompt.image ?? 'absent')}`,
    },
    'attach-selection': {
      state: prompt.embeddedContext === true ? 'supported' : 'unsupported',
      source: `acp:promptCapabilities.embeddedContext=${String(prompt.embeddedContext ?? 'absent')}`,
    },
    'resume-session': {
      state: caps.loadSession === true ? 'supported' : 'unsupported',
      source: `acp:agentCapabilities.loadSession=${String(caps.loadSession ?? 'absent')}`,
    },
    'set-title': { state: 'unknown', source: 'acp:no title method in the stable v1 surface' },
    'structured-activity': { state: 'supported', source: 'acp:session/update tool_call notifications' },
    'usage-totals': { state: 'unknown', source: 'acp:usage_update is not in every agent — unnegotiated' },
    'artifact-replies': { state: 'unsupported', source: 'acp:no artifact-thread vocabulary in v1' },
  }
}

export interface AcpSeatOptions {
  command: [cmd: string, ...args: string[]]
  cwd?: string
  spawnImpl?: SpawnImpl
}

export function acpSeatTransport(
  adapterKind: 'opencode' | 'goose',
  displayName: string,
  opts: AcpSeatOptions,
): ExternalSeatTransport {
  let child: NdjsonChildLike | null = null
  const eventListeners = new Set<(evt: SeatEvent) => void>()
  const lifecycleListeners = new Set<(s: 'connected' | 'disconnected' | 'exited') => void>()
  let eventSeq = 0

  const ensureChild = (): NdjsonChildLike => {
    if (child) return child
    const spawnImpl = opts.spawnImpl ?? realNdjsonChild
    const [cmd, ...args] = opts.command
    const c = spawnImpl(cmd, args, { cwd: opts.cwd })
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
    adapterKind,
    displayName,
    mercuryOwnsProcess: true,
    async handshake(): Promise<SeatHandshakeResult> {
      const c = ensureChild()
      const id = 1
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
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
            clientInfo: { name: 'mercury', version: '1.0' },
          },
        }),
      )
      const result = await answer
      if (!result.ok) throw new Error(`${adapterKind} ACP handshake failed: ${result.reason}`)
      const body = result.parsed as { result?: AcpInitializeResult; error?: { message?: string } }
      if (body.error) throw new Error(`${adapterKind} ACP handshake refused: ${body.error.message}`)
      const init = body.result ?? {}
      return {
        protocol: `acp@${String(init.protocolVersion ?? '1')}`,
        revision: `${init.agentInfo?.name ?? adapterKind}/${init.agentInfo?.version ?? 'unknown'}`,
        declared: acpDeclaredCapabilities(init),
        raw: { agentInfo: init.agentInfo, agentCapabilities: init.agentCapabilities },
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
