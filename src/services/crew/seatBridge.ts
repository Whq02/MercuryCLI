// ============================================================================
//  crew/seatBridge — the INWARD external-seat bridge core.
//
//  Transport-neutral: an ExternalSeatTransport is the whole adapter contract
//  — handshake, delivery, cancellation, events, detach — and each provider
//  profile (adapters/*) implements ONLY its documented boundary differences.
//  ACP is one inward path among several; nothing above this module ever sees
//  provider vocabulary (the cockpit consumes Mercury capabilities and
//  receipts, never provider conditionals).
//
//  DISTINCT from the outward `src/services/acp/acpServer.ts`, which exposes
//  Mercury TO editors. This module attaches an external agent INSIDE Mercury.
//  Shared protocol contracts may be reused; the roles never blur.
//
//  Laws:
//    · at attach: negotiate protocol/handshake, capture declared capabilities
//      as tri-state facts (capabilities.ts), establish the stable external
//      identity (the registry binding `adapter:<kind>:<stable-id>` — the SAME
//      external session re-attaching resolves the SAME CrewAgentId, a fresh
//      external session mints a new seat on the same or a new agent as the
//      adapter can prove continuity), and wire lifecycle/activity listeners;
//    · reconnect/renegotiation INVALIDATES the previous capability set before
//      the new handshake records (a stale fact cannot authorize);
//    · deliveries return exact positive/negative/unknown outcomes — a
//      timeout, disconnect or ambiguous acknowledgement is 'unknown', never
//      silently dropped, never optimistically 'accepted';
//    · Mercury cancels/closes only a process it spawned and owns; an
//      externally owned endpoint gets detach plus only its positively
//      advertised cancel/close operations (the transport declares ownership).
// ============================================================================

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
  /** The negotiated protocol identity ('codex-app-server@jsonrpc', 'acp@1', …). */
  protocol: string
  /** The adapter/CLI revision observed (userAgent, version). Establishes the
   *  capability set; a change on re-handshake invalidates. */
  revision: string
  /** The external system's OWN stable session id, when it has one. */
  externalSessionId?: string
  /** Declared capability facts (absent kinds record as 'unknown'). */
  declared: Partial<Record<CapabilityKind, { state: CapabilityState; source: string }>>
  /** Bounded raw handshake material (fixtures/diagnostics — never rendered raw). */
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
      /** Per-attachment acceptance as the adapter reported it. */
      attachments: Array<{ attachmentId: string; outcome: 'accepted' | 'rejected'; reason?: string }>
      adapterOutcome?: string
    }
  | { result: 'rejected'; reason: string }
  | { result: 'unknown'; reason: string }

/** A structured event observed from the seat (feeds the M4 classifier). */
export interface SeatEvent {
  /** The adapter's own stable event id (tool-call id, message id …). */
  sourceEventId: string
  kind: string
  payload: unknown
  atMs: number
}

export interface ExternalSeatTransport {
  adapterKind: string
  displayName: string
  /** True only when Mercury spawned and owns the endpoint process. */
  mercuryOwnsProcess: boolean
  /** True only when the adapter positively declares idempotent message-id
   * dedupe/reconciliation — the precondition for a same-id retry of a
   *  delivery-unknown outcome. Absent means NO (a caller can never assert it). */
  declaresIdempotentDelivery?: boolean
  handshake(): Promise<SeatHandshakeResult>
  deliver?(req: SeatDeliveryRequest): Promise<SeatDeliveryOutcome>
  cancelTurn?(): Promise<SeatDeliveryOutcome>
  /** Subscribe to structured events; returns unsubscribe. */
  onEvent?(listener: (evt: SeatEvent) => void): () => void
  /** Subscribe to lifecycle transitions (connected/disconnected/exited). */
  onLifecycle?(listener: (state: 'connected' | 'disconnected' | 'exited') => void): () => void
  /** Subscribe to the endpoint's OWN session identity becoming (or changing
   *  to) a provable id after attach — e.g. a session id the adapter's init
   *  frame reveals. The bridge binds it so a later re-attach of the same
   *  external session resolves the SAME agent. */
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
  /** The transport's own idempotent-delivery declaration (never caller-set). */
  declaresIdempotentDelivery: boolean
}

interface LiveSeat extends AttachedSeat {
  transport: ExternalSeatTransport
  /** The attach-time store root (proof seam) — lifecycle writes reuse it. */
  dir?: string
  eventUnsub?: () => void
  lifecycleUnsub?: () => void
  sessionIdentityUnsub?: () => void
}

const seats = new Map<string, LiveSeat>()

/**
 * Attach an external seat: handshake → identity binding → tri-state
 * capability record → listeners. Returns the attached seat view.
 */
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
  // Attach is ONE transaction: a failure after the handshake spawned a child
  // must not leak the process — roll back with a best-effort detach.
  try {
    // Stable identity: the adapter's own session id when it can prove one
    // (re-attach resolves the SAME agent); otherwise this seat instance.
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
    // A re-handshake on a known binding refreshes the observed revision.
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
    // The seat's out-of-band descriptor — republished with the
    // proven external id once the adapter reveals it (onSessionIdentity).
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
        // Every structured seat event lands in the semantic activity feed
        // (classified, in-place phase updates) before local fan-out.
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
        // The activity feed IS the one event surface (M10: the parallel
        // per-seat listener fan-out was a test-only bridge — removed).
      })
    }
    if (transport.onLifecycle) {
      live.lifecycleUnsub = transport.onLifecycle(state => {
        live.lifecycle = state
        if (state !== 'connected') {
          // A disconnect expires the observations — nothing may authorize
          // against the dead handshake; a reconnect records a fresh set.
          invalidateCapabilities(seatId, `lifecycle:${state}`)
          // The endpoint's session is not running — close the durable
          // session record so 'open' keeps meaning open.
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
      // The endpoint's provable session id can arrive AFTER attach (an
      // adapter's init frame). Bind it so a later re-attach of the same
      // external session resolves the SAME agent — and when the id is already
      // bound, re-resolve THIS seat onto its canonical owner instead of
      // minting a duplicate.
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
          // The seat-keyed placeholder descriptor is superseded — retire it
          // (wave B: a phantom live descriptor per attach otherwise).
          if (placeholderSessionId !== externalSessionId) {
            await d.retireSessionDescriptor(placeholderSessionId, dirOpt)
          }
        })().catch(e => logForDebugging(`[crew/seatBridge] session identity bind failed (ignored): ${e}`))
      })
    }
    seats.set(seatId, live)
    return toView(live)
  } catch (e) {
    // The child (if any) was spawned for THIS attach — close it rather than
    // leak an unreachable process; the identity rows already written are
    // idempotent and harmless.
    forgetCapabilities(seatId)
    try {
      await transport.detach()
    } catch (detachErr) {
      logForDebugging(`[crew/seatBridge] rollback detach threw (ignored): ${detachErr}`)
    }
    throw e
  }
}

/**
 * Re-negotiate a live seat (reconnect / revision change): the OLD set is
 * invalidated BEFORE the new handshake runs, so no operation can authorize
 * against stale facts during the window.
 */
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
  // The recovery restores the DURABLE records too: a lifecycle blip retired
  // the descriptor and ended the session — a renegotiated seat is live
  // again, so the session re-opens (registerAgentSession resumes an ended
  // id) and the descriptor republishes (a publish on a retired id clears
  // retiredAt). Without this the recovered seat read historical everywhere
  // (final audit).
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

/** Deliver through the seat's transport — outcomes map exactly, never
 *  optimistically: a thrown/timed-out delivery is 'unknown'. */
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

/** Cancel the seat's current turn — only via a positively advertised op:
 *  the LIVE declared cancel-turn fact authorizes (an invalidated or unknown
 *  fact refuses pre-flight; method presence alone never does). */
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

/** Detach: unwire listeners, expire + forget capabilities, transport detach.
 *  The transport itself enforces the ownership law (an externally owned
 *  endpoint's detach never kills the process). */
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
  // The seat's session record closes with the seat — 'open' keeps meaning open.
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

/** The ACTIVE seat bound to a crew agent — the dispatch route lookup. A dead
 *  seat left behind by a crash never shadows a live re-attached one: connected
 *  seats with valid observations win, then connected, then most recent. */
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
    // The LIVE observation set — an invalidation lands in the store, so the
    // view must re-read it; the attach-time reference would advertise expired
    // 'supported' facts after a disconnect.
    capabilities: capabilitiesOf(live.seatId) ?? live.capabilities,
    attachedAt: live.attachedAt,
    lifecycle: live.lifecycle,
    declaresIdempotentDelivery: live.declaresIdempotentDelivery,
  }
}

/** Test seam (never product-read). */
export function _resetSeatBridgeForTesting(): void {
  for (const live of seats.values()) {
    live.eventUnsub?.()
    live.lifecycleUnsub?.()
    live.sessionIdentityUnsub?.()
  }
  seats.clear()
}
