// ============================================================================
//  crew/dispatch — the ONE dispatch transaction.
//
//  Every direct interaction with a teammate goes through here: one typed
//  address, one transaction, one exact receipt. The transaction:
//    1. never mutates the caller's draft (the draft and its attachments stay
//       whole until a POSITIVE receipt lets the surface clear them);
//    2. resolves the stable target (registry agent) and its active endpoint
//       (a live external seat via the bridge, or the local routes);
//    3. confirms the requested disposition against the endpoint's LIVE
//       declared capability (tri-state; stale/unknown refuses pre-flight);
//    4. dispatches with an idempotency key (clientMessageId) — a replayed id
//       returns the recorded receipt without a second delivery (the
//       folioActions replay-ring idiom), and adapter-declared idempotent
//       retries reuse the SAME id, never double-deliver;
//    5. accepts only a positively confirmed result — ambiguous/timeout/
//       disconnect outcomes persist as 'delivery-unknown' with NO automatic
//       retry unless the adapter declares dedupe/reconciliation;
//    6. persists the exact delivered / not-delivered / delivery-unknown
//       outcome with per-instruction AND per-attachment results.
//
//  Local endpoints (the main Mercury agent) declare their own facts: the
//  command queue supports hold-next and start-turn; current-turn steering is
//  NOT declared (a Mercury-local queue is never advertised as remote steer
//  support) — the composer's own Enter-to-steer grammar remains the separate,
//  explicit surface for the operator's own session.
// ============================================================================

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { defineStore } from '../../substrate/fileStore.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { getCwd } from '../../utils/cwd.js'
import { authorizeCapability, type CapabilityKind } from './capabilities.js'
import { agentOf, crewDirectoryEnabled, listAgentBindings, type CrewAgentId, crewStoreRoot } from './identity.js'
import {
  deliverToSeat,
  seatOfAgent,
  type SeatDeliveryOutcome,
} from './seatBridge.js'

export const DELIVERY_STATES = ['delivered', 'not-delivered', 'delivery-unknown'] as const
export type DeliveryState = (typeof DELIVERY_STATES)[number]

export const DISPATCH_DISPOSITIONS = ['steer-current', 'hold-next', 'start-turn'] as const
export type DispatchDisposition = (typeof DISPATCH_DISPOSITIONS)[number]

export interface AgentAddressV1 {
  agentId: CrewAgentId
  sessionId?: string
  conversationId?: string
}

export interface DispatchAttachment {
  attachmentId: string
  kind: string
  ref: string
  label: string
}

export interface DispatchDraftV1 {
  /** The idempotency key — caller-minted, reused on declared-idempotent retry. */
  clientMessageId: string
  sourceConversationId?: string
  requestedAddress: AgentAddressV1
  requestedDisposition: DispatchDisposition
  instruction: string
  attachments: DispatchAttachment[]
}

export interface AttachmentOutcome {
  attachmentId: string
  outcome: 'accepted' | 'rejected' | 'unknown'
  reason?: string
}

export interface DeliveryReceiptV1 {
  schema: 1
  clientMessageId: string
  state: DeliveryState
  sourceConversationId?: string
  requestedAddress: AgentAddressV1
  requestedDisposition: DispatchDisposition
  /** The exact endpoint that took (or failed to take) the event. */
  resolvedAgentId?: CrewAgentId
  resultingSessionId?: string
  /** What ACTUALLY happened, when delivered. */
  disposition?: 'steered-current' | 'queued-next' | 'started-turn' | 'delivered-next-moment'
  instructionOutcome: 'accepted' | 'rejected' | 'unknown'
  attachmentOutcomes: AttachmentOutcome[]
  reason?: string
  adapterOutcome?: string
  route?: string
  observedAt: number
}

interface ReceiptFile {
  receipts: DeliveryReceiptV1[]
  /** Ids of RESOLVED receipts evicted from the full ring — a replayed id
   *  whose receipt aged out is refused, never silently re-delivered. */
  settledIds: string[]
}

const MAX_RECEIPTS = 200
const MAX_SETTLED_IDS = 2000

function projectKey(): string {
  return createHash('sha256').update(getCwd()).digest('hex').slice(0, 16)
}

const receiptStore = defineStore<ReceiptFile, [dir?: string]>({
  name: 'crew-dispatch-receipts',
  path: (dir?: string) =>
    join(crewStoreRoot(dir), `receipts-${projectKey()}.json`),
  schemaVersion: 1,
  decode: raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as { receipts?: unknown; settledIds?: unknown }
    return {
      receipts: Array.isArray(r.receipts) ? (r.receipts as DeliveryReceiptV1[]) : [],
      settledIds: Array.isArray(r.settledIds) ? (r.settledIds as string[]) : [],
    }
  },
  empty: () => ({ receipts: [], settledIds: [] }),
  onReadFailure: 'empty',
})

/** Bound the ring. Resolved receipts evict oldest-first into the settled-id
 *  index; 'delivery-unknown' receipts are NEVER evicted by resolved churn —
 *  they carry the no-auto-retry prohibition — and bound separately. */
function boundReceiptFile(file: ReceiptFile): ReceiptFile {
  if (file.receipts.length <= MAX_RECEIPTS) return file
  const unknown = file.receipts.filter(r => r.state === 'delivery-unknown')
  const resolved = file.receipts.filter(r => r.state !== 'delivery-unknown')
  const keptResolved = new Set(resolved.slice(-MAX_RECEIPTS))
  const keptUnknown = new Set(unknown.slice(-MAX_RECEIPTS))
  // EVERY evicted id joins the settled index — an evicted delivery-unknown
  // id is MORE replay-dangerous than a resolved one (its outcome was never
  // reconciled; a replay must refuse, never silently re-deliver — final
  // audit).
  const evictedIds = [
    ...resolved.filter(r => !keptResolved.has(r)),
    ...unknown.filter(r => !keptUnknown.has(r)),
  ].map(r => r.clientMessageId)
  return {
    receipts: file.receipts.filter(r => keptResolved.has(r) || keptUnknown.has(r)),
    settledIds: [...file.settledIds, ...evictedIds].slice(-MAX_SETTLED_IDS),
  }
}

const DISPOSITION_CAPABILITY: Record<DispatchDisposition, CapabilityKind> = {
  'steer-current': 'steer-current',
  'hold-next': 'hold-next',
  'start-turn': 'start-turn',
}

/** The visible target+disposition label (the one owner; surfaces render
 *  these beside the composer, never invent their own copy). */
export function dispositionLabelOf(disposition: DispatchDisposition, targetLabel: string): string {
  switch (disposition) {
    case 'steer-current':
      return `Steer ${targetLabel} now`
    case 'hold-next':
      return `Hold for ${targetLabel} next`
    case 'start-turn':
      return `Start a turn with ${targetLabel}`
  }
}


export async function readDeliveryReceipt(
  clientMessageId: string,
  opts?: { dir?: string },
): Promise<DeliveryReceiptV1 | null> {
  const file = await receiptStore(opts?.dir).read()
  return file.receipts.find(r => r.clientMessageId === clientMessageId) ?? null
}

export async function listDeliveryReceipts(opts?: { dir?: string }): Promise<DeliveryReceiptV1[]> {
  return (await receiptStore(opts?.dir).read()).receipts
}

async function persistReceipt(receipt: DeliveryReceiptV1, dir?: string): Promise<DeliveryReceiptV1> {
  await receiptStore(dir).mutate(current =>
    boundReceiptFile({
      receipts: [...current.receipts.filter(r => r.clientMessageId !== receipt.clientMessageId), receipt],
      settledIds: current.settledIds,
    }),
  )
  return receipt
}

/** Local endpoint facts for the main Mercury agent: the command queue holds
 *  next and starts turns; it is NEVER advertised as remote current-turn
 *  steering (the separate-fact law). */
function localMainDispositionSupported(disposition: DispatchDisposition): boolean {
  return disposition === 'hold-next' || disposition === 'start-turn'
}

export interface DispatchOptions {
  /** Adapter-declared idempotent retry: reuse the SAME clientMessageId. When
   *  the recorded receipt for the id is 'delivery-unknown' and the adapter
   *  declared no dedupe/reconciliation, the transaction REFUSES the retry —
   *  the operator's explicit new-copy choice mints a new id instead. */
  retryDeclaredIdempotent?: boolean
  dir?: string
}

/** In-flight dispatches by clientMessageId — a same-process double submit
 *  (double Enter) joins the running transaction instead of double-delivering. */
const pendingDispatches = new Map<string, Promise<DeliveryReceiptV1>>()

/**
 * THE transaction. Returns the exact receipt; the caller's draft object is
 * never touched (clearing is the surface's move, only on state==='delivered').
 */
export async function dispatchToAgent(
  draft: DispatchDraftV1,
  opts?: DispatchOptions,
): Promise<DeliveryReceiptV1> {
  // The crew-directory kill flag governs every crew store write — with it off
  // the transaction refuses WITHOUT persisting anything.
  if (!crewDirectoryEnabled()) {
    return {
      schema: 1,
      clientMessageId: draft.clientMessageId,
      state: 'not-delivered',
      requestedAddress: draft.requestedAddress,
      requestedDisposition: draft.requestedDisposition,
      instructionOutcome: 'rejected',
      attachmentOutcomes: draft.attachments.map(a => ({
        attachmentId: a.attachmentId,
        outcome: 'rejected' as const,
        reason: 'crew directory disabled',
      })),
      reason: 'the crew directory is disabled (MERCURY_CREW_DIRECTORY=0)',
      observedAt: Date.now(),
    }
  }
  const pendingKey = `${opts?.dir ?? ''}|${draft.clientMessageId}`
  const pending = pendingDispatches.get(pendingKey)
  if (pending) return pending
  const run = runDispatchTransaction(draft, opts)
  pendingDispatches.set(pendingKey, run)
  try {
    return await run
  } finally {
    pendingDispatches.delete(pendingKey)
  }
}

async function runDispatchTransaction(
  draft: DispatchDraftV1,
  opts?: DispatchOptions,
): Promise<DeliveryReceiptV1> {
  const dir = opts?.dir

  const base = {
    schema: 1 as const,
    clientMessageId: draft.clientMessageId,
    ...(draft.sourceConversationId !== undefined
      ? { sourceConversationId: draft.sourceConversationId }
      : {}),
    requestedAddress: draft.requestedAddress,
    requestedDisposition: draft.requestedDisposition,
    observedAt: Date.now(),
  }

  // Idempotency: the replay check and the id reservation are ONE atomic store
  // mutation — an in-flight placeholder claims the id BEFORE any delivery, so
  // overlapping same-id dispatches (even across processes sharing the durable
  // store) can never both deliver. A crash mid-delivery leaves the honest
  // 'delivery-unknown / in flight' receipt behind.
  const placeholder: DeliveryReceiptV1 = {
    ...base,
    state: 'delivery-unknown',
    instructionOutcome: 'unknown',
    attachmentOutcomes: draft.attachments.map(a => ({
      attachmentId: a.attachmentId,
      outcome: 'unknown' as const,
      reason: 'dispatch in flight',
    })),
    reason: 'dispatch in flight — outcome not yet observed',
  }
  type Reservation =
    | { kind: 'existing'; receipt: DeliveryReceiptV1 }
    | { kind: 'settled-evicted' }
    | { kind: 'reserved' }
  const reservation = await receiptStore(dir).update<Reservation>(current => {
    const found = current.receipts.find(r => r.clientMessageId === draft.clientMessageId)
    if (found) return { next: current, result: { kind: 'existing' as const, receipt: found } }
    if (current.settledIds.includes(draft.clientMessageId)) {
      return { next: current, result: { kind: 'settled-evicted' as const } }
    }
    return {
      next: boundReceiptFile({
        receipts: [...current.receipts, placeholder],
        settledIds: current.settledIds,
      }),
      result: { kind: 'reserved' as const },
    }
  })
  if (reservation.kind === 'settled-evicted') {
    // The id's full receipt aged out — its true outcome is unrecoverable, so
    // re-delivery is refused and the original history is NOT rewritten (this
    // refusal receipt stays unpersisted).
    return {
      ...base,
      state: 'not-delivered',
      instructionOutcome: 'rejected',
      attachmentOutcomes: draft.attachments.map(a => ({
        attachmentId: a.attachmentId,
        outcome: 'rejected' as const,
        reason: 'replayed id',
      })),
      reason:
        'replayed clientMessageId: the original receipt aged out of the ring — refusing re-delivery; an explicit new send mints a new id',
      route: 'replay-guard',
    }
  }
  let retryingUnknown: DeliveryReceiptV1 | null = null
  if (reservation.kind === 'existing') {
    if (reservation.receipt.state === 'delivery-unknown' && opts?.retryDeclaredIdempotent) {
      // Provisionally a retry — the ADAPTER's own idempotency declaration is
      // verified at the resolved endpoint below; a caller boolean alone never
      // authorizes a re-send.
      retryingUnknown = reservation.receipt
    } else {
      return reservation.receipt
    }
  }

  let receipt: DeliveryReceiptV1
  try {
    receipt = await performDispatch(draft, base, retryingUnknown, dir)
  } catch (e) {
    // The transaction died mid-flight — the fate of anything already written
    // to a wire is unobserved. Finalize the reserved receipt honestly.
    receipt = await persistReceipt(
      {
        ...base,
        state: 'delivery-unknown',
        instructionOutcome: 'unknown',
        attachmentOutcomes: draft.attachments.map(a => ({
          attachmentId: a.attachmentId,
          outcome: 'unknown' as const,
        })),
        reason: `transaction failed mid-flight (${String(e).slice(0, 120)}) — outcome not observed`,
      },
      dir,
    )
  }
  // The source conversation records the outcome as ITS event (a delivered
  // send is history; anything else owes the operator a resolution) — only
  // when THIS call actually ran the transaction: the reservation FACT says
  // so (reserved, or a declared retry that re-delivered), never a clock
  // comparison (same-ms replays must not double-post). A REFUSED retry
  // returns the recorded receipt by reference — nothing ran, nothing posts
  // (final audit: a refused retry re-opened an operator-cleared obligation).
  const ranTransaction =
    reservation.kind === 'reserved' || (retryingUnknown !== null && receipt !== retryingUnknown)
  if (draft.sourceConversationId !== undefined && ranTransaction) {
    try {
      const conversations = await import('./conversations.js')
      const ref = `receipt:${receipt.clientMessageId}`
      if (receipt.state === 'delivered') {
        await conversations.appendConversationEvent(
          draft.sourceConversationId as never,
          {
            kind: 'delivery',
            ref,
            label: `delivered · ${receipt.disposition ?? 'accepted'}`,
          },
          dir !== undefined ? { dir } : undefined,
        )
        // A recovery settles its own past: the failure event a prior unknown
        // outcome posted for THIS id resolves the moment the retry delivers.
        await conversations.resolveEventByRef(
          draft.sourceConversationId as never,
          'failure',
          ref,
          dir !== undefined ? { dir } : undefined,
        )
      } else {
        // One OPEN failure per receipt id — atomic upsert, never a duplicate.
        await conversations.upsertUnresolvedEvent(
          draft.sourceConversationId as never,
          {
            kind: 'failure',
            ref,
            label: `${receipt.state}${receipt.reason ? ` — ${receipt.reason.slice(0, 80)}` : ''}`,
          },
          dir !== undefined ? { dir } : undefined,
        )
      }
      // the DURABLE needs-you twin of the ring
      // events above — the ring evicts, obligations do not. Same ref, same
      // atomic one-open-row law, same recovery settlement; the attention
      // projection reads these via the obligations gatherer. Authoritative
      // by construction: the raiser is the delivery receipt itself (a receipt-raised row —
      // never prose).
      const obligations = await import('./obligations.js')
      if (receipt.state === 'delivered') {
        await obligations.resolveObligationByRef(ref, {
          kind: 'resolved',
          answerRef: ref,
          // The same one file the raise writes (the switchboard scope) —
          // a recovery that settles a different file leaves the row open.
          scope: 'switchboard',
          ...(dir !== undefined ? { dir } : {}),
        })
      } else {
        const { getSessionId } = await import('../../bootstrap/state.js')
        let sessionId = 'unknown-session'
        try {
          sessionId = String(getSessionId())
        } catch {
          /* pre-boot dispatch paths keep the honest placeholder */
        }
        await obligations.upsertObligation({
          ref,
          sessionId,
          conversationId: draft.sourceConversationId,
          sourceEventRef: ref,
          question: `dispatch to ${draft.requestedAddress.agentId} was ${receipt.state}${receipt.reason ? ` — ${receipt.reason.slice(0, 80)}` : ''}; retry or withdraw?`,
          owner: 'operator',
          // The SWITCHBOARD scope — the one cwd-independent file every
          // consumer reads (the attention bridge, the concourse, the host
          // signals). The ambient cwd-hashed mint this site carried left
          // its rows visible only to a process on the same cwd.
          scope: 'switchboard',
          ...(dir !== undefined ? { dir } : {}),
        })
      }
    } catch {
      // conversation projection is bounded best-effort; the receipt is the truth
    }
  }
  return receipt
}

async function performDispatch(
  draft: DispatchDraftV1,
  base: Omit<DeliveryReceiptV1, 'state' | 'instructionOutcome' | 'attachmentOutcomes'>,
  retryingUnknown: DeliveryReceiptV1 | null,
  dir?: string,
): Promise<DeliveryReceiptV1> {
  // 1. Resolve the stable target.
  const agent = await agentOf(draft.requestedAddress.agentId, dir !== undefined ? { dir } : undefined)
  if (!agent) {
    return persistReceipt(
      {
        ...base,
        state: 'not-delivered',
        instructionOutcome: 'rejected',
        attachmentOutcomes: draft.attachments.map(a => ({
          attachmentId: a.attachmentId,
          outcome: 'rejected' as const,
          reason: 'target unresolved',
        })),
        reason: `no registry agent '${draft.requestedAddress.agentId}'`,
      },
      dir,
    )
  }

  // 2. Find the active endpoint: a live external seat wins; the main agent
  //    rides the local queue facts.
  const seat = seatOfAgent(agent.agentId)
  if (seat) {
    // A same-id retry of an unresolved outcome runs ONLY when the adapter
    // itself declared idempotent delivery — otherwise the recorded receipt
    // stands and nothing is re-sent (the operator's explicit new-copy choice
    // mints a new id instead).
    if (retryingUnknown && !seat.declaresIdempotentDelivery) {
      return retryingUnknown
    }
    // 3. Capability confirmation against the LIVE observed set.
    const auth = authorizeCapability(seat.seatId, DISPOSITION_CAPABILITY[draft.requestedDisposition])
    if (!auth.ok) {
      return persistReceipt(
        {
          ...base,
          state: 'not-delivered',
          resolvedAgentId: agent.agentId,
          instructionOutcome: 'rejected',
          attachmentOutcomes: draft.attachments.map(a => ({
            attachmentId: a.attachmentId,
            outcome: 'rejected' as const,
            reason: 'disposition refused pre-flight',
          })),
          reason: auth.reason,
          route: `seat:${seat.adapterKind}`,
        },
        dir,
      )
    }
    // Per-attachment capability confirmation (file/image/selection kinds).
    const attachmentAuth = draft.attachments.map(a => {
      const kind: CapabilityKind | null =
        a.kind === 'file'
          ? 'attach-file'
          : a.kind === 'image'
            ? 'attach-image'
            : a.kind === 'selection'
              ? 'attach-selection'
              : null
      if (kind === null) return { attachment: a, ok: true as const }
      const r = authorizeCapability(seat.seatId, kind)
      return r.ok
        ? { attachment: a, ok: true as const }
        : { attachment: a, ok: false as const, reason: r.reason }
    })
    const deliverable = attachmentAuth.filter(x => x.ok).map(x => x.attachment)
    // 4/5. Deliver with the idempotency key; only a positive result counts.
    const outcome: SeatDeliveryOutcome = await deliverToSeat(seat.seatId, {
      clientMessageId: draft.clientMessageId,
      disposition: draft.requestedDisposition,
      instruction: draft.instruction,
      attachments: deliverable,
    })
    if (outcome.result === 'accepted') {
      const reported = new Map(outcome.attachments.map(a => [a.attachmentId, a]))
      return persistReceipt(
        {
          ...base,
          state: 'delivered',
          resolvedAgentId: agent.agentId,
          ...(seat.externalSessionId !== undefined ? { resultingSessionId: seat.externalSessionId } : {}),
          disposition: outcome.disposition,
          instructionOutcome: 'accepted',
          attachmentOutcomes: draft.attachments.map(a => {
            const refused = attachmentAuth.find(x => x.attachment.attachmentId === a.attachmentId && !x.ok)
            if (refused) {
              return {
                attachmentId: a.attachmentId,
                outcome: 'rejected' as const,
                reason: (refused as { reason?: string }).reason ?? 'capability refused',
              }
            }
            const r = reported.get(a.attachmentId)
            return r
              ? { attachmentId: a.attachmentId, outcome: r.outcome, ...(r.reason ? { reason: r.reason } : {}) }
              : { attachmentId: a.attachmentId, outcome: 'unknown' as const, reason: 'adapter reported nothing for this part' }
          }),
          ...(outcome.adapterOutcome !== undefined ? { adapterOutcome: outcome.adapterOutcome } : {}),
          route: `seat:${seat.adapterKind}`,
        },
        dir,
      )
    }
    if (outcome.result === 'rejected') {
      return persistReceipt(
        {
          ...base,
          state: 'not-delivered',
          resolvedAgentId: agent.agentId,
          instructionOutcome: 'rejected',
          attachmentOutcomes: draft.attachments.map(a => ({
            attachmentId: a.attachmentId,
            outcome: 'rejected' as const,
          })),
          reason: outcome.reason,
          route: `seat:${seat.adapterKind}`,
        },
        dir,
      )
    }
    return persistReceipt(
      {
        ...base,
        state: 'delivery-unknown',
        resolvedAgentId: agent.agentId,
        instructionOutcome: 'unknown',
        attachmentOutcomes: draft.attachments.map(a => ({
          attachmentId: a.attachmentId,
          outcome: 'unknown' as const,
        })),
        reason: outcome.reason,
        route: `seat:${seat.adapterKind}`,
      },
      dir,
    )
  }

  // Local endpoint: the main Mercury agent over the command queue routes.
  const bindings = await listAgentBindings(agent.agentId, dir !== undefined ? { dir } : undefined)
  const isMain = bindings.some(b => b.bindingKind === 'principal' && b.bindingId === 'agent-mercury')
  if (isMain) {
    // The local queue declares no dedupe/reconciliation — a same-id retry of
    // an unresolved outcome is always refused here.
    if (retryingUnknown) {
      return retryingUnknown
    }
    if (!localMainDispositionSupported(draft.requestedDisposition)) {
      return persistReceipt(
        {
          ...base,
          state: 'not-delivered',
          resolvedAgentId: agent.agentId,
          instructionOutcome: 'rejected',
          attachmentOutcomes: draft.attachments.map(a => ({
            attachmentId: a.attachmentId,
            outcome: 'rejected' as const,
          })),
          reason:
            "the local queue holds next and starts turns; a Mercury-local queue is never advertised as current-turn steering — use the composer's own steer grammar",
          route: 'local:command-queue',
        },
        dir,
      )
    }
    const { submitDispatch, mintIntentId } = await import('../../services/attention/actions.js')
    const receipt = await submitDispatch({
      intentId: mintIntentId(),
      kind: 'board-dispatch',
      value: draft.instruction,
    })
    if (receipt.kind === 'dispatch-accepted') {
      return persistReceipt(
        {
          ...base,
          state: 'delivered',
          resolvedAgentId: agent.agentId,
          // The delivery law: the session HAS the words (delivered
          // instantly, read at its next readable moment) — the receipt
          // records exactly that, never a drain-timing guess.
          disposition: 'delivered-next-moment',
          instructionOutcome: 'accepted',
          // The delivery route carries only the instruction text — no
          // attachment ever enters this route, so none is receipted as sent.
          attachmentOutcomes: draft.attachments.map(a => ({
            attachmentId: a.attachmentId,
            outcome: 'rejected' as const,
            reason: 'the session-delivery route carries no attachments — include the content inline',
          })),
          adapterOutcome: 'session-delivery-accepted',
          route: 'local:session-delivery',
        },
        dir,
      )
    }
    return persistReceipt(
      {
        ...base,
        state: 'not-delivered',
        resolvedAgentId: agent.agentId,
        instructionOutcome: 'rejected',
        attachmentOutcomes: draft.attachments.map(a => ({
          attachmentId: a.attachmentId,
          outcome: 'rejected' as const,
        })),
        reason: receipt.reason,
        route: 'local:session-delivery',
      },
      dir,
    )
  }

  return persistReceipt(
    {
      ...base,
      state: 'not-delivered',
      resolvedAgentId: agent.agentId,
      instructionOutcome: 'rejected',
      attachmentOutcomes: draft.attachments.map(a => ({
        attachmentId: a.attachmentId,
        outcome: 'rejected' as const,
      })),
      reason: `no active endpoint for '${agent.displayName}' — no live seat, no local route`,
    },
    dir,
  )
}

// ── the law probe (repro-dispatch's pin — runs in an OWN scratch world) ──────

export async function __dispatchLawsForProof(): Promise<{
  draftPreservedOnUnknown: boolean
  noAutoRetryWithoutDeclaredIdempotency: boolean
  perAttachmentOutcomes: boolean
  clearOnlyAfterPositiveReceipt: boolean
}> {
  const { mkdtempSync, realpathSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'crew-dispatchprobe-')))
  const { ensureAgentIdentity } = await import('./identity.js')
  const { attachExternalSeat, _resetSeatBridgeForTesting } = await import('./seatBridge.js')
  const { _resetCapabilitiesForTesting } = await import('./capabilities.js')
  _resetSeatBridgeForTesting()
  _resetCapabilitiesForTesting()

  let deliverCalls = 0
  const flaky = {
    adapterKind: 'probe-adapter',
    displayName: 'Probe',
    mercuryOwnsProcess: true,
    handshake: async () => ({
      protocol: 'probe@1',
      revision: 'probe-1',
      externalSessionId: 'probe-ext-1',
      declared: {
        'hold-next': { state: 'supported' as const, source: 'probe' },
        'attach-file': { state: 'supported' as const, source: 'probe' },
        'attach-image': { state: 'unsupported' as const, source: 'probe' },
      },
    }),
    deliver: async () => {
      deliverCalls++
      return { result: 'unknown' as const, reason: 'probe: ack lost' }
    },
    detach: async () => {},
  }
  const seat = await attachExternalSeat(flaky, { displayName: 'Probe', dir })

  const draft: DispatchDraftV1 = {
    clientMessageId: 'probe-msg-1',
    requestedAddress: { agentId: seat.agentId },
    requestedDisposition: 'hold-next',
    instruction: 'probe instruction',
    attachments: [
      { attachmentId: 'att-1', kind: 'file', ref: '/tmp/x', label: 'x' },
      { attachmentId: 'att-2', kind: 'image', ref: 'image:1', label: 'img' },
    ],
  }
  const frozen = JSON.stringify(draft)
  const r1 = await dispatchToAgent(draft, { dir })
  const draftPreservedOnUnknown = r1.state === 'delivery-unknown' && JSON.stringify(draft) === frozen

  // A bare repeat replays the receipt; the adapter declared no dedupe, so no
  // second delivery happens.
  const before = deliverCalls
  const r2 = await dispatchToAgent(draft, { dir })
  const noAutoRetryWithoutDeclaredIdempotency =
    deliverCalls === before && r2.observedAt === r1.observedAt

  const perAttachmentOutcomes =
    r1.attachmentOutcomes.length === 2 &&
    r1.attachmentOutcomes.every(a => a.outcome === 'unknown')

  // clear-only-after-positive: the receipt states expose exactly one positive
  // state; unknown/not-delivered can never read as clearable.
  const clearable = (r: DeliveryReceiptV1): boolean => r.state === 'delivered'
  const clearOnlyAfterPositiveReceipt = clearable(r1) === false && DELIVERY_STATES.includes('delivered')

  return {
    draftPreservedOnUnknown,
    noAutoRetryWithoutDeclaredIdempotency,
    perAttachmentOutcomes,
    clearOnlyAfterPositiveReceipt,
  }
}
