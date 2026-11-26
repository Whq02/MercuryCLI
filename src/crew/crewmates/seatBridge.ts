import { randomUUID } from 'node:crypto'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import type { ExternalSeatPermissionAsk } from '../../permissions/cards/externalSeatAsk.js'
import { ingestActivity } from './activity.js'
import {
  authorizeCapability,
  invalidateCapabilities,
  capabilitiesOf,
  forgetCapabilities,
  recordCapabilities,
  type CapabilityKind,
  type CapabilitySetV1,
  type CapabilityState,
} from './capabilities.js'
import {
  bindAgent,
  crewDirectoryEnabled,
  endAgentSession,
  ensureAgentIdentity,
  registerAgentSession,
  resolveAgent,
  type CrewAgentId,
} from './identity.js'

export interface SeatHandshakeResult {
  protocol: string
  revision: string
  externalSessionId?: string
  declared: Partial<Record<CapabilityKind, { state: CapabilityState; source: string }>>
  raw?: unknown
}

export interface SeatDeliveryRequest {
  clientMessageId: string
  disposition: 'steer-current' | 'hold-next' | 'start-turn'
  instruction: string
  attachments: Array<{ attachmentId: string; kind: string; ref: string; label: string }>
}

export type SeatDeliveryOutcome =
  | {
      result: 'accepted'
      disposition: 'steered-current' | 'queued-next' | 'started-turn' | 'delivered-next-moment'
      attachments: Array<{ attachmentId: string; outcome: 'accepted' | 'rejected'; reason?: string }>
      adapterOutcome?: string
    }
  | { result: 'rejected'; reason: string }
  | { result: 'unknown'; reason: string }

export interface SeatEvent {
  sourceEventId: string
  kind: string
  payload: unknown
  atMs: number
}

export interface SeatTurnSettlement {
  seatId: string
  sessionId?: string
  clientMessageId: string
  status: 'completed' | 'cancelled' | 'failed' | 'exited'
  stopReason?: string
  reason?: string
  reply?: string
  replyChars?: number
  replySavedChars?: number
  replyOmittedChars?: number
  replyTruncated?: boolean
  replyOverflowPath?: string
  replySaveError?: string
  atMs: number
}

export interface ExternalSeatHostContext {
  seatId: string
  agentId: CrewAgentId
  postAsk: (ask: ExternalSeatPermissionAsk) => () => void
  hasAskConsumer: () => boolean
}

export interface ExternalSeatTransport {
  adapterKind: string
  displayName: string
  mercuryOwnsProcess: boolean
  declaresIdempotentDelivery?: boolean
  handshake(): Promise<SeatHandshakeResult>
  bindSeat?(ctx: ExternalSeatHostContext): void
  deliver?(req: SeatDeliveryRequest): Promise<SeatDeliveryOutcome>
  cancelTurn?(): Promise<SeatDeliveryOutcome>
  onEvent?(listener: (evt: SeatEvent) => void): () => void
  onLifecycle?(listener: (state: 'connected' | 'disconnected' | 'exited') => void): () => void
  onSessionIdentity?(listener: (externalSessionId: string) => void): () => void
  onTurnSettled?(listener: (settlement: Omit<SeatTurnSettlement, 'seatId'>) => void): () => void
  detach(): Promise<void>
}

interface AttachedSeat {
  seatId: string
  agentId: CrewAgentId
  adapterKind: string
  displayName: string
  protocol: string
  revision: string
  externalSessionId?: string
  capabilities: CapabilitySetV1
  attachedAt: number
  lifecycle: 'connected' | 'disconnected' | 'exited'
  declaresIdempotentDelivery: boolean
}

interface LiveSeat extends AttachedSeat {
  transport: ExternalSeatTransport
  dir?: string
  eventUnsub?: () => void
  lifecycleUnsub?: () => void
  sessionIdentityUnsub?: () => void
  turnSettledUnsub?: () => void
}

class SeatBridgeRegistry {
  readonly live = new Map<string, LiveSeat>()
  readonly externalAsks: ExternalSeatPermissionAsk[] = []
  externalAsksSnapshot: readonly ExternalSeatPermissionAsk[] = []
  readonly askListeners = new Set<() => void>()
  readonly turnListeners = new Map<string, Set<(s: SeatTurnSettlement) => void>>()
  readonly lastTurns = new Map<string, SeatTurnSettlement>()
  emitAsks(): void {
    this.externalAsksSnapshot = [...this.externalAsks]
    for (const listener of [...this.askListeners]) {
      try {
        listener()
      } catch (e) {
        logForDebugging(`[crew/seatBridge] ask listener threw (ignored): ${e}`)
      }
    }
  }

  postAsk(ask: ExternalSeatPermissionAsk): () => void {
    if (!this.externalAsks.some(existing => existing.askId === ask.askId)) {
      this.externalAsks.push(ask)
      this.emitAsks()
    }
    return () => {
      this.removeAskById(ask.askId)
    }
  }

  removeAskById(askId: string): boolean {
    const idx = this.externalAsks.findIndex(existing => existing.askId === askId)
    if (idx < 0) return false
    this.externalAsks.splice(idx, 1)
    this.emitAsks()
    return true
  }

  withdrawSeatAsks(seatId: string): void {
    const before = this.externalAsks.length
    for (let i = this.externalAsks.length - 1; i >= 0; i--) {
      if (this.externalAsks[i]!.seatId === seatId) {
        this.externalAsks.splice(i, 1)
      }
    }
    if (this.externalAsks.length !== before) {
      this.emitAsks()
    }
  }

  emitTurnSettled(settlement: SeatTurnSettlement): void {
    this.lastTurns.set(settlement.seatId, settlement)
    const listeners = this.turnListeners.get(settlement.seatId)
    if (!listeners) return
    for (const listener of [...listeners]) {
      try {
        listener(settlement)
      } catch (e) {
        logForDebugging(`[crew/seatBridge] turn listener threw (ignored): ${e}`)
      }
    }
  }
}

const seats = new SeatBridgeRegistry()

export function listExternalSeatAsks(): readonly ExternalSeatPermissionAsk[] {
  return seats.externalAsksSnapshot
}

export function subscribeExternalSeatAsks(listener: () => void): () => void {
  seats.askListeners.add(listener)
  return () => {
    seats.askListeners.delete(listener)
  }
}

export function settleExternalSeatAsk(askId: string): boolean {
  return seats.removeAskById(askId)
}

export function onSeatTurnSettled(
  seatId: string,
  listener: (settlement: SeatTurnSettlement) => void,
): () => void {
  let set = seats.turnListeners.get(seatId)
  if (!set) {
    set = new Set()
    seats.turnListeners.set(seatId, set)
  }
  set.add(listener)
  return () => {
    set?.delete(listener)
    if (set && set.size === 0) seats.turnListeners.delete(seatId)
  }
}

export function lastSeatTurn(seatId: string): SeatTurnSettlement | null {
  return seats.lastTurns.get(seatId) ?? null
}

function wireSeatSubscriptions(live: LiveSeat, dirOpt: { dir: string } | undefined): void {
  const { transport, seatId } = live
  transport.bindSeat?.({
    seatId,
    agentId: live.agentId,
    postAsk: ask => seats.postAsk(ask),
    hasAskConsumer: () => seats.askListeners.size > 0,
  })
  if (transport.onEvent) {
    live.eventUnsub = transport.onEvent(evt => {
      try {
        const evtSessionId =
          typeof evt.payload === 'object' &&
          evt.payload !== null &&
          typeof (evt.payload as { sessionId?: unknown }).sessionId === 'string' &&
          (evt.payload as { sessionId: string }).sessionId !== ''
            ? (evt.payload as { sessionId: string }).sessionId
            : undefined
        ingestActivity({
          event: evt,
          agentId: live.agentId,
          sessionId: evtSessionId ?? live.externalSessionId ?? live.seatId,
          adapterKind: live.adapterKind,
        })
      } catch (e) {
        logForDebugging(`[crew/seatBridge] activity ingest failed (ignored): ${e}`)
      }
    })
  }
  if (transport.onLifecycle) {
    live.lifecycleUnsub = transport.onLifecycle(state => {
      live.lifecycle = state
      if (state !== 'connected') {
        seats.withdrawSeatAsks(seatId)
        invalidateCapabilities(seatId, `lifecycle:${state}`)
        void endAgentSession(live.externalSessionId ?? live.seatId, live.dir !== undefined ? { dir: live.dir } : undefined).catch(e =>
          logForDebugging(`[crew/seatBridge] session close on lifecycle loss failed (ignored): ${e}`),
        )
        void import('./descriptor.js')
          .then(d =>
            d.retireSessionDescriptor(
              live.externalSessionId ?? live.seatId,
              live.dir !== undefined ? { dir: live.dir } : undefined,
            ),
          )
          .catch(e =>
            logForDebugging(`[crew/seatBridge] descriptor retire on lifecycle loss failed, the seat stays listed as live: ${e}`),
          )
      }
    })
  }
  if (transport.onSessionIdentity) {
    live.sessionIdentityUnsub = transport.onSessionIdentity(externalSessionId => {
      void (async () => {
        if (live.externalSessionId === externalSessionId) return
        const provenId = `${transport.adapterKind}:${externalSessionId}`
        const existing = await resolveAgent({ bindingKind: 'adapter', bindingId: provenId }, dirOpt)
        if (existing) {
          live.agentId = existing
        } else {
          const receipt = await bindAgent(
            live.agentId,
            {
              bindingKind: 'adapter',
              bindingId: provenId,
              adapterKind: transport.adapterKind,
              observedRevision: live.revision,
            },
            dirOpt,
          )
          if (!receipt.ok) {
            logForDebugging(
              `[crew/seatBridge] session identity '${provenId}' refused (${receipt.reason}) — seat keeps its attach binding`,
            )
            return
          }
        }
        await registerAgentSession({ sessionId: externalSessionId, agentId: live.agentId }, dirOpt)
        const placeholderSessionId = live.externalSessionId ?? live.seatId
        live.externalSessionId = externalSessionId
        const d = await import('./descriptor.js')
        await d.publishSessionDescriptor({ agentId: live.agentId, sessionId: externalSessionId }, dirOpt)
        if (placeholderSessionId !== externalSessionId) {
          await d.retireSessionDescriptor(placeholderSessionId, dirOpt)
        }
      })().catch(e => logForDebugging(`[crew/seatBridge] session identity bind failed (ignored): ${e}`))
    })
  }
  if (transport.onTurnSettled) {
    live.turnSettledUnsub = transport.onTurnSettled(settlement => {
      seats.emitTurnSettled({ ...settlement, seatId })
    })
  }
}

export async function attachExternalSeat(
  transport: ExternalSeatTransport,
  opts?: { displayName?: string; dir?: string },
): Promise<AttachedSeat> {
  if (!crewDirectoryEnabled()) {
    throw new Error('the crew directory is disabled (MERCURY_CREW_DIRECTORY=0)')
  }
  const handshake = await transport.handshake()
  const seatId = `seat-${randomUUID().replace(/-/g, '').slice(0, 12)}`
  const dirOpt = opts?.dir !== undefined ? { dir: opts.dir } : undefined
  try {
    const stableId = handshake.externalSessionId
      ? `${transport.adapterKind}:${handshake.externalSessionId}`
      : `${transport.adapterKind}:${seatId}`
    const displayName = opts?.displayName ?? transport.displayName
    const identity = await ensureAgentIdentity({
      displayName,
      binding: {
        bindingKind: 'adapter',
        bindingId: stableId,
        adapterKind: transport.adapterKind,
        observedRevision: handshake.revision,
      },
      ...(opts?.dir !== undefined ? { dir: opts.dir } : {}),
    })
    await bindAgent(
      identity.agentId,
      {
        bindingKind: 'adapter',
        bindingId: stableId,
        adapterKind: transport.adapterKind,
        observedRevision: handshake.revision,
      },
      dirOpt,
    )
    await registerAgentSession(
      {
        sessionId: handshake.externalSessionId ?? seatId,
        agentId: identity.agentId,
      },
      dirOpt,
    )
    void import('./descriptor.js')
      .then(d =>
        d.publishSessionDescriptor(
          { agentId: identity.agentId, sessionId: handshake.externalSessionId ?? seatId },
          opts?.dir !== undefined ? { dir: opts.dir } : undefined,
        ),
      )
      .catch(e => logForDebugging(`[crew/seatBridge] descriptor publish failed (ignored): ${e}`))
    const capabilities = recordCapabilities({
      seatId,
      adapterKind: transport.adapterKind,
      revision: handshake.revision,
      declared: handshake.declared,
    })
    const live: LiveSeat = {
      seatId,
      agentId: identity.agentId,
      adapterKind: transport.adapterKind,
      displayName,
      protocol: handshake.protocol,
      revision: handshake.revision,
      ...(handshake.externalSessionId !== undefined
        ? { externalSessionId: handshake.externalSessionId }
        : {}),
      capabilities,
      attachedAt: Date.now(),
      lifecycle: 'connected',
      declaresIdempotentDelivery: transport.declaresIdempotentDelivery === true,
      ...(opts?.dir !== undefined ? { dir: opts.dir } : {}),
      transport,
    }
    wireSeatSubscriptions(live, dirOpt)
    seats.live.set(seatId, live)
    return toView(live)
  } catch (e) {
    forgetCapabilities(seatId)
    try {
      await transport.detach()
    } catch (detachErr) {
      logForDebugging(`[crew/seatBridge] rollback detach threw (ignored): ${detachErr}`)
    }
    throw e
  }
}

export async function renegotiateSeat(seatId: string): Promise<AttachedSeat | null> {
  const live = seats.live.get(seatId)
  if (!live) return null
  seats.withdrawSeatAsks(seatId)
  invalidateCapabilities(seatId, 'renegotiation')
  const handshake = await live.transport.handshake()
  live.revision = handshake.revision
  live.protocol = handshake.protocol
  live.capabilities = recordCapabilities({
    seatId,
    adapterKind: live.adapterKind,
    revision: handshake.revision,
    declared: handshake.declared,
  })
  live.lifecycle = 'connected'
  const sessionId = live.externalSessionId
  if (sessionId !== undefined) {
    try {
      await registerAgentSession({ sessionId, agentId: live.agentId })
      const d = await import('./descriptor.js')
      await d.publishSessionDescriptor({ agentId: live.agentId, sessionId })
    } catch (e) {
      logForDebugging(`[crew/seatBridge] renegotiate record restore failed (ignored): ${e}`)
    }
  }
  return toView(live)
}

export async function deliverToSeat(
  seatId: string,
  req: SeatDeliveryRequest,
): Promise<SeatDeliveryOutcome> {
  const live = seats.live.get(seatId)
  if (!live) return { result: 'rejected', reason: `no attached seat '${seatId}'` }
  if (!live.transport.deliver) {
    return { result: 'rejected', reason: `${live.adapterKind} declares no delivery operation` }
  }
  try {
    return await live.transport.deliver(req)
  } catch (e) {
    return {
      result: 'unknown',
      reason: `delivery outcome unobservable (${String(e).slice(0, 120)}) — not confirmed, not refuted`,
    }
  }
}

export async function cancelSeatTurn(seatId: string): Promise<SeatDeliveryOutcome> {
  const live = seats.live.get(seatId)
  if (!live) return { result: 'rejected', reason: `no attached seat '${seatId}'` }
  if (!live.transport.cancelTurn) {
    return { result: 'rejected', reason: `${live.adapterKind} advertises no cancel operation` }
  }
  const auth = authorizeCapability(seatId, 'cancel-turn')
  if (!auth.ok) {
    return { result: 'rejected', reason: auth.reason }
  }
  try {
    return await live.transport.cancelTurn()
  } catch (e) {
    return { result: 'unknown', reason: `cancel outcome unobservable (${String(e).slice(0, 120)})` }
  }
}

export async function detachExternalSeat(seatId: string): Promise<boolean> {
  const live = seats.live.get(seatId)
  if (!live) return false
  live.eventUnsub?.()
  live.lifecycleUnsub?.()
  live.sessionIdentityUnsub?.()
  live.turnSettledUnsub?.()
  seats.withdrawSeatAsks(seatId)
  seats.turnListeners.delete(seatId)
  seats.lastTurns.delete(seatId)
  invalidateCapabilities(seatId, 'detached')
  try {
    await live.transport.detach()
  } catch (e) {
    logForDebugging(`[crew/seatBridge] transport detach threw (seat still removed): ${e}`)
  }
  forgetCapabilities(seatId)
  seats.live.delete(seatId)
  const sessionId = live.externalSessionId ?? live.seatId
  const dirOpt = live.dir !== undefined ? { dir: live.dir } : undefined
  try {
    await endAgentSession(sessionId, dirOpt)
  } catch (e) {
    logForDebugging(`[crew/seatBridge] session close on detach failed (ignored): ${e}`)
  }
  try {
    const d = await import('./descriptor.js')
    await d.retireSessionDescriptor(sessionId, dirOpt)
  } catch (e) {
    logForDebugging(`[crew/seatBridge] descriptor retire on detach failed, the seat stays listed as live: ${e}`)
  }
  return true
}

export function listAttachedSeats(): AttachedSeat[] {
  return [...seats.live.values()].map(toView)
}

export function attachedSeatOf(seatId: string): AttachedSeat | null {
  const live = seats.live.get(seatId)
  return live ? toView(live) : null
}

export function seatOfAgent(agentId: CrewAgentId): AttachedSeat | null {
  const rank = (live: LiveSeat): number => {
    if (live.lifecycle !== 'connected') return 0
    const set = capabilitiesOf(live.seatId)
    return set !== null && set.invalidatedAt === undefined ? 2 : 1
  }
  let best: LiveSeat | null = null
  for (const live of seats.live.values()) {
    if (live.agentId !== agentId) continue
    if (
      best === null ||
      rank(live) > rank(best) ||
      (rank(live) === rank(best) && live.attachedAt > best.attachedAt)
    ) {
      best = live
    }
  }
  return best ? toView(best) : null
}

function toView(live: LiveSeat): AttachedSeat {
  return {
    seatId: live.seatId,
    agentId: live.agentId,
    adapterKind: live.adapterKind,
    displayName: live.displayName,
    protocol: live.protocol,
    revision: live.revision,
    ...(live.externalSessionId !== undefined ? { externalSessionId: live.externalSessionId } : {}),
    capabilities: capabilitiesOf(live.seatId) ?? live.capabilities,
    attachedAt: live.attachedAt,
    lifecycle: live.lifecycle,
    declaresIdempotentDelivery: live.declaresIdempotentDelivery,
  }
}

export function _resetSeatBridgeForTesting(): void {
  for (const live of seats.live.values()) {
    live.eventUnsub?.()
    live.lifecycleUnsub?.()
    live.sessionIdentityUnsub?.()
    live.turnSettledUnsub?.()
  }
  seats.live.clear()
  seats.externalAsks.length = 0
  seats.externalAsksSnapshot = []
  seats.askListeners.clear()
  seats.turnListeners.clear()
  seats.lastTurns.clear()
}
