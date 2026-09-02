
import { randomUUID } from 'node:crypto'
import { logForDebugging } from '../../utils/debug.js'
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

export interface ExternalSeatTransport {
  adapterKind: string
  displayName: string
  mercuryOwnsProcess: boolean
  declaresIdempotentDelivery?: boolean
  handshake(): Promise<SeatHandshakeResult>
  deliver?(req: SeatDeliveryRequest): Promise<SeatDeliveryOutcome>
  cancelTurn?(): Promise<SeatDeliveryOutcome>
  onEvent?(listener: (evt: SeatEvent) => void): () => void
  onLifecycle?(listener: (state: 'connected' | 'disconnected' | 'exited') => void): () => void
  onSessionIdentity?(listener: (externalSessionId: string) => void): () => void
  detach(): Promise<void>
}

export interface AttachedSeat {
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
}

const seats = new Map<string, LiveSeat>()

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
    if (transport.onEvent) {
      live.eventUnsub = transport.onEvent(evt => {
        try {
          ingestActivity({
            event: evt,
            agentId: live.agentId,
            sessionId: live.externalSessionId ?? live.seatId,
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
            .catch(() => {})
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
    seats.set(seatId, live)
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
  const live = seats.get(seatId)
  if (!live) return null
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
  const live = seats.get(seatId)
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
  const live = seats.get(seatId)
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
  const live = seats.get(seatId)
  if (!live) return false
  live.eventUnsub?.()
  live.lifecycleUnsub?.()
  live.sessionIdentityUnsub?.()
  invalidateCapabilities(seatId, 'detached')
  try {
    await live.transport.detach()
  } catch (e) {
    logForDebugging(`[crew/seatBridge] transport detach threw (seat still removed): ${e}`)
  }
  forgetCapabilities(seatId)
  seats.delete(seatId)
  try {
    await endAgentSession(live.externalSessionId ?? live.seatId, live.dir !== undefined ? { dir: live.dir } : undefined)
    const d = await import('./descriptor.js')
    await d.retireSessionDescriptor(
      live.externalSessionId ?? live.seatId,
      live.dir !== undefined ? { dir: live.dir } : undefined,
    )
  } catch (e) {
    logForDebugging(`[crew/seatBridge] session close on detach failed (ignored): ${e}`)
  }
  return true
}

export function listAttachedSeats(): AttachedSeat[] {
  return [...seats.values()].map(toView)
}

export function attachedSeatOf(seatId: string): AttachedSeat | null {
  const live = seats.get(seatId)
  return live ? toView(live) : null
}

export function seatOfAgent(agentId: CrewAgentId): AttachedSeat | null {
  const rank = (live: LiveSeat): number => {
    if (live.lifecycle !== 'connected') return 0
    const set = capabilitiesOf(live.seatId)
    return set !== null && set.invalidatedAt === undefined ? 2 : 1
  }
  let best: LiveSeat | null = null
  for (const live of seats.values()) {
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
  for (const live of seats.values()) {
    live.eventUnsub?.()
    live.lifecycleUnsub?.()
    live.sessionIdentityUnsub?.()
  }
  seats.clear()
}
