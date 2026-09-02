// ============================================================================
//  crew/adapters/acpProfile — the ACP v1 inward seat profile (M3).
//
//  OpenCode and goose both attach through the Agent Client Protocol (v1 —
//  the same stable protocol Mercury's OUTWARD acpServer speaks; this is the
//  inward client half). Neither CLI is installed on this host, so their
//  conformance evidence is FIXTURE-TIER (scripts/session-graph/fixtures/
//  {opencode,goose}.fixture.json — authored from the documented ACP v1
//  initialize/session contract): the fixtures replay through THIS real
//  profile code. The scorecard row records the tier honestly; a live
//  install upgrades the evidence without changing this code.
//
//  Capability mapping is DERIVED from the initialize response — absence maps
//  per the ACP contract (an undeclared promptCapability is absent-by-protocol
//  ⇒ unsupported; undeclared optional methods ⇒ unknown).
// ============================================================================

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

/** Derive tri-state facts from an ACP initialize result. */
export function acpDeclaredCapabilities(
  init: AcpInitializeResult,
): Partial<Record<CapabilityKind, { state: CapabilityState; source: string }>> {
  const caps = init.agentCapabilities ?? {}
  const prompt = caps.promptCapabilities ?? {}
  return {
    // ACP v1 offers session/prompt and session/cancel, but THIS transport does
    // not implement deliver/cancelTurn yet — a declared 'supported' would
    // advertise an operation that cannot run (the availability law). The facts
    // stay 'unknown' until the operations land; the source names why.
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
  /** The launch command for the agent's ACP mode (e.g. ['opencode','acp']). */
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
  // Monotonic per-transport sequence: notifications carry no owner event id,
  // and wall-clock ms collides inside one stdout chunk — a counter never does.
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
      // Clear the corpse so the next operation respawns instead of writing
      // into a closed stdin.
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
      // close awaits settlement (SIGTERM → grace → SIGKILL,
      // bounded) — a fire-and-forget kill left the child's fate unknown.
      const c = child
      child = null
      if (c) await (c.killAndWait?.() ?? Promise.resolve(c.kill()))
    },
  }
}
