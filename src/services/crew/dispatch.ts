
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
  resolvedAgentId?: CrewAgentId
  resultingSessionId?: string
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

function boundReceiptFile(file: ReceiptFile): ReceiptFile {
  if (file.receipts.length <= MAX_RECEIPTS) return file
  const unknown = file.receipts.filter(r => r.state === 'delivery-unknown')
  const resolved = file.receipts.filter(r => r.state !== 'delivery-unknown')
  const keptResolved = new Set(resolved.slice(-MAX_RECEIPTS))
  const keptUnknown = new Set(unknown.slice(-MAX_RECEIPTS))
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

function localMainDispositionSupported(disposition: DispatchDisposition): boolean {
  return disposition === 'hold-next' || disposition === 'start-turn'
}

export interface DispatchOptions {
  retryDeclaredIdempotent?: boolean
  dir?: string
}

const pendingDispatches = new Map<string, Promise<DeliveryReceiptV1>>()

export async function dispatchToAgent(
  draft: DispatchDraftV1,
  opts?: DispatchOptions,
): Promise<DeliveryReceiptV1> {
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
      retryingUnknown = reservation.receipt
    } else {
      return reservation.receipt
    }
  }

  let receipt: DeliveryReceiptV1
  try {
    receipt = await performDispatch(draft, base, retryingUnknown, dir)
  } catch (e) {
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
        await conversations.resolveEventByRef(
          draft.sourceConversationId as never,
          'failure',
          ref,
          dir !== undefined ? { dir } : undefined,
        )
      } else {
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
      const obligations = await import('./obligations.js')
      if (receipt.state === 'delivered') {
        await obligations.resolveObligationByRef(ref, {
          kind: 'resolved',
          answerRef: ref,
          scope: 'switchboard',
          ...(dir !== undefined ? { dir } : {}),
        })
      } else {
        const { getSessionId } = await import('../../bootstrap/state.js')
        let sessionId = 'unknown-session'
        try {
          sessionId = String(getSessionId())
        } catch {
        }
        await obligations.upsertObligation({
          ref,
          sessionId,
          conversationId: draft.sourceConversationId,
          sourceEventRef: ref,
          question: `dispatch to ${draft.requestedAddress.agentId} was ${receipt.state}${receipt.reason ? ` — ${receipt.reason.slice(0, 80)}` : ''}; retry or withdraw?`,
          owner: 'operator',
          scope: 'switchboard',
          ...(dir !== undefined ? { dir } : {}),
        })
      }
    } catch {
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

  const seat = seatOfAgent(agent.agentId)
  if (seat) {
    if (retryingUnknown && !seat.declaresIdempotentDelivery) {
      return retryingUnknown
    }
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

  const bindings = await listAgentBindings(agent.agentId, dir !== undefined ? { dir } : undefined)
  const isMain = bindings.some(b => b.bindingKind === 'principal' && b.bindingId === 'agent-mercury')
  if (isMain) {
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
          disposition: 'delivered-next-moment',
          instructionOutcome: 'accepted',
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

  const before = deliverCalls
  const r2 = await dispatchToAgent(draft, { dir })
  const noAutoRetryWithoutDeclaredIdempotency =
    deliverCalls === before && r2.observedAt === r1.observedAt

  const perAttachmentOutcomes =
    r1.attachmentOutcomes.length === 2 &&
    r1.attachmentOutcomes.every(a => a.outcome === 'unknown')

  const clearable = (r: DeliveryReceiptV1): boolean => r.state === 'delivered'
  const clearOnlyAfterPositiveReceipt = clearable(r1) === false && DELIVERY_STATES.includes('delivered')

  return {
    draftPreservedOnUnknown,
    noAutoRetryWithoutDeclaredIdempotency,
    perAttachmentOutcomes,
    clearOnlyAfterPositiveReceipt,
  }
}
