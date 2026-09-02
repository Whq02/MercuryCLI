
import { actionFingerprint } from '../run/progressModel.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  executeKernelDecision,
  kernelObjectRefOf,
  resolveCoordinatorMode,
  runCoordinatorKernel,
  type CoordinatorModeResolution,
  type KernelDecisionV1,
  type KernelDeps,
  type KernelEventV1,
  type KernelReceiptV1,
} from './coordinatorKernel.js'
import { COORDINATOR_PERSONA, COORDINATOR_PERSONA_VERSION } from './coordinatorPersona.js'
import { coordinatorOverflowOf, coordinatorOverflowRefusal } from './coordinatorOverflow.js'
import { overflowRecoveryEnabled } from '../compact/overflowRecovery.js'
import { isAutoCompactEnabled } from '../compact/autoCompact.js'
import type { CoordinatorBoardV1 } from './coordinatorBoard.js'
import type { CoordinatorTurnRuntime } from './coordinatorTools.js'
import { decodeManagerAsk, decodeManagerPlan, type ManagerAskV1, type ManagerPlanV1 } from './managerMode.js'


function receiptLabel(r: { verb: string; objectRef: string; outcome: string; detail?: string }): string {
  const ref = r.objectRef.length > 12 ? `${r.objectRef.slice(0, 8)}…` : r.objectRef
  const why = r.detail !== undefined && r.detail.length > 0 ? ` — ${r.detail}` : ''
  return `${r.verb} ${r.outcome}${why} · ${ref}`.slice(0, 240)
}

export const COORDINATOR_CONTRACT_VERSION = COORDINATOR_PERSONA_VERSION
export const COORDINATOR_CONTRACT = COORDINATOR_PERSONA

export function coordinatorContractDigest(): string {
  return `cc${COORDINATOR_CONTRACT_VERSION}-${COORDINATOR_CONTRACT.length}`
}


export interface EffectiveCoordinator {
  resolution: CoordinatorModeResolution
  assistModelId?: string
  assistModelLabel?: string
  assistModelAvailability?: import('./coordinatorModels.js').CoordinatorModelAvailability
  assistModelStatus?: string
}

export async function resolveEffectiveCoordinator(): Promise<EffectiveCoordinator> {
  const { getGlobalConfig } = await import('../../utils/config.js')
  const cfg = getGlobalConfig().concourseCoordinator
  const base = resolveCoordinatorMode(cfg?.mode)
  if (base.requested !== 'agent-assisted') return { resolution: base }
  const { validateCoordinatorModelChoice, coordinatorModelStatusLabel } = await import('./coordinatorModels.js')
  const validated = await validateCoordinatorModelChoice(cfg?.assistModel)
  if (!validated.ok) {
    return {
      resolution: {
        requested: 'agent-assisted',
        effective: 'rules-only',
        fallbackReason:
          validated.reason === 'no-choice'
            ? 'agent-assisted needs a coordinator model — pick one from the composed registry'
            : `the chosen coordinator model (${cfg?.assistModel ?? ''}) is not in the registry — pick one from the composed registry`,
      },
    }
  }
  const status = coordinatorModelStatusLabel(validated.entry)
  return {
    resolution: { requested: 'agent-assisted', effective: 'agent-assisted' },
    assistModelId: validated.entry.modelId,
    assistModelLabel: validated.entry.displayName,
    ...(status.length > 0 ? { assistModelAvailability: validated.entry.availability, assistModelStatus: status } : {}),
  }
}


export type CoordinatorTurnBoard = CoordinatorBoardV1

export interface CoordinatorTurnInput {
  contractVersion: number
  contract: string
  event: KernelEventV1
  board: CoordinatorTurnBoard
  conversation?: ReadonlyArray<import('./coordinatorReplay.js').CoordinatorReplayRowV1>
  manager?: true
}

const RECEIPT_VERB_WORDS: Record<string, string> = {
  'session.launch': 'launch',
  'session.redirect': 'message to',
  'session.pause': 'pause',
  'session.resume': 'resume',
  'session.stop': 'stop',
  'workflows.grant': 'workflows allowed for',
  'workflows.revoke': 'workflows revoked for',
  'permission.answer': 'permission answer',
  'attention.raise': 'raised a question',
  'attention.supersede': 'closed a question',
  'obligation.answer': 'answered',
  'signal.emit': 'signalled',
}

export function compactRefusalWhy(detail: string | undefined): string {
  if (detail === undefined || detail.trim().length === 0) return 'no reason came back'
  detail = detail.replace(/\s*\r?\n+\s*/g, ' · ')
  const bareId = /^[a-z0-9][\w./:-]*$/i
  const folded: Array<{ text: string; roll: boolean }> = []
  for (const raw of detail.split(' · ')) {
    const c = raw.replace(/^next:\s*/, '').trim()
    if (c.length === 0) continue
    const header = /^(?:dispatchable:|pick one of:?)\s*(.*)$/i.exec(c)
    if (header !== null) {
      folded.push({ text: (header[1] ?? '').trim(), roll: true })
      continue
    }
    const last = folded[folded.length - 1]
    if (last !== undefined && last.roll && bareId.test(c)) {
      last.text = last.text === '' ? c : `${last.text} · ${c}`
      continue
    }
    folded.push({ text: c, roll: false })
  }
  const hasFix = folded.some(f => !f.roll && /did you mean/i.test(f.text))
  const out: string[] = []
  const seen = new Set<string>()
  for (const f of folded) {
    let c: string
    if (f.roll) {
      if (hasFix) continue
      const ids = f.text.split(' · ').filter(s => s !== '')
      if (ids.length === 0) continue
      c = `pick one of: ${ids.slice(0, 3).join(' · ')}${ids.length > 3 ? ` (+${ids.length - 3} more)` : ''}`
    } else {
      c = f.text
        .replace(/\s*\(got [^)]*\)/, '')
        .replace(/^model (?:refused|unavailable) \([a-z0-9:-]+\)\s*(?:—\s*)?/i, '')
        .trim()
    }
    if (c.length === 0) continue
    const key = c.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return (out.length > 0 ? out.join(' · ') : detail).slice(0, 200)
}

export function receiptLabelOf(
  r: { verb: string; objectRef: string; outcome: string; detail?: string },
  titleOf: (objectRef: string) => string | undefined = () => undefined,
): string {
  const verbWord = RECEIPT_VERB_WORDS[r.verb] ?? r.verb
  const title = titleOf(r.objectRef)
  const opaqueRef = /^coord-[a-z]+-[0-9a-f-]{8,}$/i.test(r.objectRef)
  const subject =
    title !== undefined
      ? `"${title}"`
      : /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(r.objectRef)
        ? `session ${r.objectRef.slice(0, 8)}`
        : opaqueRef
          ? null
          : r.objectRef
  if (r.outcome === 'refused' || r.outcome === 'failed') {
    return `${verbWord}${subject !== null ? ` ${subject}` : ''} ${r.outcome} — ${compactRefusalWhy(r.detail)}`.slice(0, 220)
  }
  const detail = r.detail !== undefined && r.detail.length > 0 ? ` — ${r.detail}` : ''
  return `${verbWord}${subject !== null ? ` ${subject}` : ''}: ${r.outcome}${detail}`.slice(0, 400)
}

export interface CoordinatorTurnProposal {
  decisions: KernelDecisionV1[]
  smallestQuestion?: string
  reply?: string
  turnUsage?: { contextTokens: number }
  ask?: ManagerAskV1
  plan?: ManagerPlanV1
}

export interface CoordinatorLaneDeps extends KernelDeps {
  callModel?: (
    input: CoordinatorTurnInput,
    modelId: string,
    runtime?: CoordinatorTurnRuntime,
  ) => Promise<CoordinatorTurnProposal>
  board?: CoordinatorTurnInput['board']
  manager?: boolean
  managerModelId?: string
  summarizeForCompact?: import('./coordinatorCompact.js').CoordinatorSummarizer
}

export interface AssistedTurnReceipt {
  outcome: 'executed' | 'deduped' | 'refused' | 'not-assisted'
  reason?: string
  contractDigest: string
  modelId?: string
  receipts: KernelReceiptV1[]
  refusedProposals?: number
  smallestQuestion?: string
  reply?: string
  receiptLabels?: Array<{ verb: string; outcome: string; label: string }>
  ask?: ManagerAskV1
  plan?: ManagerPlanV1
}


export const COORDINATOR_REPLY_CAP = 8000
const REPLY_CLIP_MARKER = '\n\n[reply clipped — it ran past the surface cap; the receipt rows are complete]'

export function clipCoordinatorReply(raw: string): string {
  if (raw.length <= COORDINATOR_REPLY_CAP) return raw
  return raw.slice(0, COORDINATOR_REPLY_CAP - REPLY_CLIP_MARKER.length) + REPLY_CLIP_MARKER
}


const MAX_REMEMBERED = 64
const seenTriggers: string[] = []
const failedBatches: string[] = []

function remember(list: string[], key: string): void {
  list.push(key)
  if (list.length > MAX_REMEMBERED) list.shift()
}

export function triggerKeyOf(event: KernelEventV1): string {
  switch (event.kind) {
    case 'dispatch-refused':
      return actionFingerprint(`refused:${event.clientMessageId}`)
    case 'worker-settled':
      return actionFingerprint(`settled:${event.sessionId}`)
    case 'obligation-open':
      return actionFingerprint(`open:${event.obligationId}`)
    case 'operator-message':
      return actionFingerprint(`msg:${event.messageId}`)
  }
}

export function batchKeyOf(decisions: readonly KernelDecisionV1[]): string {
  return actionFingerprint(JSON.stringify(decisions))
}

export function _resetCoordinatorLaneForTesting(): void {
  seenTriggers.length = 0
  failedBatches.length = 0
}

export function validateProposal(d: unknown): d is KernelDecisionV1 {
  if (typeof d !== 'object' || d === null) return false
  const v = (d as { verb?: unknown }).verb
  if (v === 'attention.raise') {
    const r = d as Record<string, unknown>
    return (
      typeof r.ref === 'string' &&
      r.ref.length > 0 &&
      r.ref.length <= 200 &&
      typeof r.sessionId === 'string' &&
      r.sessionId.length > 0 &&
      r.sessionId.length <= 128 &&
      typeof r.question === 'string' &&
      r.question.length > 0 &&
      r.question.length <= 500 &&
      r.owner === 'operator'
    )
  }
  if (v === 'attention.supersede') {
    const r = d as Record<string, unknown>
    return typeof r.obligationId === 'string' && typeof r.reason === 'string' && r.reason.length <= 500
  }
  if (v === 'session.pause') {
    const r = d as Record<string, unknown>
    return (
      typeof r.sessionId === 'string' &&
      r.sessionId.length > 0 &&
      r.sessionId.length <= 128 &&
      typeof r.by === 'string' &&
      r.by.length <= 128 &&
      typeof r.reason === 'string' &&
      r.reason.length <= 500
    )
  }
  if (v === 'session.resume') {
    const r = d as Record<string, unknown>
    return typeof r.sessionId === 'string' && r.sessionId.length > 0 && r.sessionId.length <= 128 && typeof r.by === 'string' && r.by.length <= 128
  }
  if (v === 'session.redirect') {
    const r = d as Record<string, unknown>
    return (
      typeof r.sessionId === 'string' &&
      r.sessionId.length > 0 &&
      r.sessionId.length <= 128 &&
      typeof r.clientMessageId === 'string' &&
      r.clientMessageId.length > 0 &&
      r.clientMessageId.length <= 128 &&
      typeof r.instruction === 'string' &&
      r.instruction.length > 0 &&
      r.instruction.length <= 4000 &&
      typeof r.by === 'string' &&
      r.by.length <= 128
    )
  }
  return false
}

export const MAX_PROPOSALS_PER_TURN = 5


export async function runAssistedTurn(
  event: KernelEventV1,
  deps: CoordinatorLaneDeps,
): Promise<AssistedTurnReceipt> {
  const contractDigest = coordinatorContractDigest()
  if (event.kind !== 'operator-message') {
    const receipts = await runCoordinatorKernel(event, { ...deps, mode: 'rules-only' })
    return { outcome: 'executed', contractDigest, receipts }
  }
  const effective: EffectiveCoordinator =
    deps.manager === true && deps.managerModelId !== undefined
      ? { resolution: { requested: 'agent-assisted', effective: 'agent-assisted' }, assistModelId: deps.managerModelId }
      : await resolveEffectiveCoordinator()
  if (effective.resolution.effective !== 'agent-assisted' || effective.assistModelId === undefined) {
    return {
      outcome: 'not-assisted',
      reason: effective.resolution.fallbackReason ?? `mode is ${effective.resolution.effective}`,
      contractDigest,
      receipts: [],
    }
  }
  const trigger = triggerKeyOf(event)
  if (seenTriggers.includes(trigger)) {
    return { outcome: 'deduped', reason: 'equivalent trigger already coordinated', contractDigest, receipts: [] }
  }
  remember(seenTriggers, trigger)

  try {
    return await runAssistedTurnGoverned(event, deps, effective.assistModelId, contractDigest)
  } catch (err) {
    const at = seenTriggers.indexOf(trigger)
    if (at >= 0) seenTriggers.splice(at, 1)
    const reason = `coordinator turn failed — ${err instanceof Error ? err.message : String(err)}`
    try {
      await (await import('./coordinatorReceipts.js')).ingestCoordinatorTurnRefusal({
        reason,
        modelId: effective.assistModelId,
        ...(deps.crewDir !== undefined ? { crewDir: deps.crewDir } : {}),
      })
    } catch {
    }
    return {
      outcome: 'refused',
      reason,
      contractDigest,
      modelId: effective.assistModelId,
      receipts: [],
    }
  }
}

async function runAssistedTurnGoverned(
  event: KernelEventV1,
  deps: CoordinatorLaneDeps,
  assistModelId: string,
  contractDigest: string,
): Promise<AssistedTurnReceipt> {
  const governor = await import('../capacity/governor.js')
  const callId = `coordinator:${triggerKeyOf(event)}`
  const permit = await governor.acquireModelPermit({ lane: 'coordinator', callId })
  try {
    const board: CoordinatorTurnInput['board'] =
      deps.board ??
      (await (await import('./coordinatorBoard.js'))
        .coordinatorBoardView(deps.crewDir !== undefined ? { crewDir: deps.crewDir } : {})
        .catch(
          (err): CoordinatorTurnInput['board'] => ({
            counts: {},
            sessions: [],
            openObligations: [],
            degraded: `the board could not be read — ${err instanceof Error ? err.message : String(err)}`,
          }),
        ))
    const titleOf = (objectRef: string): string | undefined =>
      board.sessions.find(s => s.sessionId === objectRef)?.title
    const callModel =
      deps.callModel ?? (await import('./coordinatorCall.js')).liveCoordinatorCallModel
    const conv = await import('./coordinatorConversation.js')
    const { buildCoordinatorReplay } = await import('./coordinatorReplay.js')
    const conversation =
      event.kind === 'operator-message'
        ? buildCoordinatorReplay(await conv.readCoordinatorConversation(), Date.now())
        : undefined
    const { coordinatorAgentId } = await import('./coordinatorIdentity.js')
    const actor = await coordinatorAgentId(
      deps.crewDir !== undefined ? { dir: deps.crewDir } : undefined,
    ).catch(() => 'coordinator-unresolved' as never)
    const feed = await import('./coordinatorReceipts.js').catch(() => null)
    const messageId = event.kind === 'operator-message' ? event.messageId : undefined
    const toolReceipts: KernelReceiptV1[] = []
    const partialRows: Array<{ verb: string; outcome: string; label: string }> = []
    let settledSegments = ''
    let segmentText = ''
    let partialText = ''
    let turnClosed = false
    let appendChain: Promise<unknown> = Promise.resolve()
    let flushTimer: ReturnType<typeof setTimeout> | undefined
    const flushPartial = (): void => {
      if (turnClosed || messageId === undefined) return
      const text = partialText
      const rows = partialRows.slice(-24)
      appendChain = appendChain
        .then(() =>
          conv.appendCoordinatorConversation({
            id: `co:${messageId}`,
            role: 'coordinator',
            text,
            ts: Date.now(),
            ...(rows.length > 0 ? { receipts: rows } : {}),
          }),
        )
        .catch(() => undefined)
    }
    const scheduleFlush = (): void => {
      if (turnClosed || messageId === undefined || flushTimer !== undefined) return
      flushTimer = setTimeout(() => {
        flushTimer = undefined
        flushPartial()
      }, 120)
      flushTimer.unref?.()
    }
    const runtime: CoordinatorTurnRuntime = {
      by: actor,
      ...(deps.crewDir !== undefined ? { crewDir: deps.crewDir } : {}),
      onDelta: text => {
        if (segmentText.length > 0 && !text.startsWith(segmentText)) {
          settledSegments = settledSegments === '' ? segmentText : `${settledSegments}\n\n${segmentText}`
        }
        segmentText = text
        partialText = settledSegments === '' ? segmentText : `${settledSegments}\n\n${segmentText}`
        scheduleFlush()
      },
      onReceipt: r => {
        const stamped = { ...r, actorAgentId: actor } as unknown as KernelReceiptV1
        toolReceipts.push(stamped)
        partialRows.push({
          verb: r.verb,
          outcome: r.outcome,
          label: receiptLabelOf(r, titleOf),
        })
        if (r.feedEligible === true && feed !== null) {
          try {
            feed.ingestCoordinatorReceipts([stamped])
          } catch {
          }
        }
        scheduleFlush()
      },
    }
    let proposal: CoordinatorTurnProposal
    const inputFor = (tail: typeof conversation): CoordinatorTurnInput => ({
      contractVersion: COORDINATOR_CONTRACT_VERSION,
      contract: COORDINATOR_CONTRACT,
      event,
      board,
      ...(tail !== undefined ? { conversation: tail } : {}),
      ...(deps.manager === true ? { manager: true as const } : {}),
    })
    try {
      try {
        proposal = await callModel(inputFor(conversation), assistModelId, runtime)
      } catch (err) {
        const overflow = coordinatorOverflowOf(err)
        if (overflow === null || !overflowRecoveryEnabled() || event.kind !== 'operator-message') throw err
        if (!isAutoCompactEnabled()) throw new Error(coordinatorOverflowRefusal(overflow, 'auto-compact-off'))
        const compact = await import('./coordinatorCompact.js')
        const folded = await compact.summarizeCoordinatorConversation({
          trigger: 'overflow',
          modelId: assistModelId,
          overflow,
          ...(deps.summarizeForCompact !== undefined ? { summarize: deps.summarizeForCompact } : {}),
        })
        if (folded.refused !== undefined) throw new Error(coordinatorOverflowRefusal(overflow, 'fold-refused', folded.refused))
        if (folded.compacted === 0) throw new Error(coordinatorOverflowRefusal(overflow, 'nothing-to-fold'))
        logForDebugging(`[coordinator/overflow] folded ${folded.compacted} turns after ${overflow.family} refused (${overflow.shape}) — retrying the turn once`)
        const refolded = buildCoordinatorReplay(await conv.readCoordinatorConversation(), Date.now())
        try {
          proposal = await callModel(inputFor(refolded), assistModelId, runtime)
        } catch (again) {
          const still = coordinatorOverflowOf(again)
          if (still === null) throw again
          throw new Error(coordinatorOverflowRefusal(still, 'retry-overflowed'))
        }
      }
    } finally {
      turnClosed = true
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer)
        flushTimer = undefined
      }
      await appendChain
    }
    if (proposal.turnUsage !== undefined) {
      await conv
        .stampCoordinatorGauge({
          contextTokens: proposal.turnUsage.contextTokens,
          modelId: assistModelId,
          ts: Date.now(),
        })
        .catch(() => undefined)
    }
    const shaped = proposal.decisions.filter(validateProposal)
    const validated = shaped.slice(0, MAX_PROPOSALS_PER_TURN)
    const vocabularyRefused = proposal.decisions.length - shaped.length
    const capDropped = shaped.length - validated.length
    const refusedProposals = vocabularyRefused + capDropped
    const smallestQuestion =
      typeof proposal.smallestQuestion === 'string' && proposal.smallestQuestion.length > 0
        ? proposal.smallestQuestion.slice(0, 500)
        : undefined
    if (smallestQuestion !== undefined) {
      try {
        await (await import('./coordinatorReceipts.js')).ingestCoordinatorSmallestQuestion({
          question: smallestQuestion,
          modelId: assistModelId,
          ...(deps.crewDir !== undefined ? { crewDir: deps.crewDir } : {}),
        })
      } catch {
      }
    }
    const batch = batchKeyOf(validated)
    if (validated.length > 0 && failedBatches.includes(batch)) {
      const reason = 'an equivalent proposal batch already failed — a genuinely changed strategy is required'
      try {
        await (await import('./coordinatorReceipts.js')).ingestCoordinatorTurnRefusal({
          reason,
          modelId: assistModelId,
          ...(deps.crewDir !== undefined ? { crewDir: deps.crewDir } : {}),
        })
      } catch {
      }
      return {
        outcome: 'refused',
        reason,
        contractDigest,
        modelId: assistModelId,
        receipts: toolReceipts,
        refusedProposals,
      }
    }
    const decisionReceipts: KernelReceiptV1[] = []
    for (const d of validated) {
      try {
        const stamped = 'by' in d ? ({ ...d, by: actor } as typeof d) : d
        decisionReceipts.push({ ...(await executeKernelDecision(stamped, deps)), actorAgentId: actor })
      } catch (err) {
        decisionReceipts.push({
          verb: d.verb,
          objectRef: kernelObjectRefOf(d),
          outcome: 'refused',
          detail: `owner threw — ${err instanceof Error ? err.message : String(err)}`,
          actorAgentId: actor,
        })
      }
    }
    if (validated.length > 0 && decisionReceipts.some(r => r.outcome === 'refused'))
      remember(failedBatches, batch)
    try {
      if (feed !== null) {
        feed.ingestCoordinatorReceipts(decisionReceipts)
        if (vocabularyRefused > 0) {
          await feed.ingestCoordinatorTurnRefusal({
            reason: `${vocabularyRefused} proposal(s) outside the closed vocabulary — refused, not executed`,
            refusedProposals: vocabularyRefused,
            modelId: assistModelId,
            actorAgentId: actor,
          })
        }
        if (capDropped > 0) {
          await feed.ingestCoordinatorTurnRefusal({
            reason: `${capDropped} proposal(s) beyond the per-turn bound (${MAX_PROPOSALS_PER_TURN}) — dropped, not executed`,
            refusedProposals: capDropped,
            modelId: assistModelId,
            actorAgentId: actor,
          })
        }
      }
    } catch {
    }
    const streamedWhole = partialText.trim()
    const proposalReply =
      typeof proposal.reply === 'string' && proposal.reply.trim().length > 0
        ? proposal.reply.trim()
        : undefined
    const rawReply =
      proposalReply !== undefined
        ? streamedWhole.length > proposalReply.length
          ? streamedWhole
          : proposalReply
        : streamedWhole.length > 0
          ? streamedWhole
          : undefined
    const reply = rawReply !== undefined ? clipCoordinatorReply(rawReply) : undefined
    const receipts = [...toolReceipts, ...decisionReceipts]
    for (const r of receipts) {
      if ((r.outcome === 'refused' || r.outcome === 'failed') && r.detail !== undefined && r.detail.length > 0) {
        logForDebugging(`[coordinator/receipt] ${r.verb} ${r.objectRef} ${r.outcome} — ${r.detail}`)
      }
    }
    const managerAsk = proposal.ask !== undefined ? decodeManagerAsk(proposal.ask) : null
    const managerPlan = proposal.plan !== undefined ? decodeManagerPlan(proposal.plan) : null
    return {
      outcome: 'executed',
      contractDigest,
      modelId: assistModelId,
      receipts,
      receiptLabels: receipts.map(r => ({ verb: r.verb, outcome: r.outcome, label: receiptLabelOf(r, titleOf) })),
      ...(reply !== undefined ? { reply } : {}),
      ...(refusedProposals > 0 ? { refusedProposals } : {}),
      ...(smallestQuestion !== undefined ? { smallestQuestion } : {}),
      ...(managerAsk !== null ? { ask: managerAsk } : {}),
      ...(managerPlan !== null ? { plan: managerPlan } : {}),
    }
  } finally {
    governor.releaseModelPermit(permit.permitId)
  }
}


export interface SelfManagedLaunchSignal {
  kind: 'self-managed-launch'
  text: string
}

export async function runOperatorMessageTurn(
  text: string,
  deps: CoordinatorLaneDeps,
  opts: { clientMessageId?: string; onAccepted?: () => void; manager?: boolean } = {},
): Promise<AssistedTurnReceipt | SelfManagedLaunchSignal> {
  const conv = await import('./coordinatorConversation.js')
  const { randomUUID } = await import('../../utils/crypto.js')
  const messageId = opts.clientMessageId ?? randomUUID()
  const bounded = text.slice(0, 4000)
  const now = Date.now()
  const prior = await conv.readCoordinatorConversation()
  if (prior.some(e => e.id === `co:${messageId}`)) {
    opts.onAccepted?.()
    return {
      outcome: 'deduped',
      reason: 'equivalent trigger already coordinated (durable replay)',
      contractDigest: coordinatorContractDigest(),
      receipts: [],
    }
  }
  if (!prior.some(e => e.id === `op:${messageId}`))
    await conv.appendCoordinatorConversation({ id: `op:${messageId}`, role: 'operator', text: bounded, ts: now })
  opts.onAccepted?.()
  const effective = await resolveEffectiveCoordinator()
  const managerModel =
    opts.manager === true && effective.resolution.effective !== 'agent-assisted'
      ? await (await import('./managerMode.js')).resolveManagerModel()
      : null
  if (managerModel !== null && !managerModel.ok) {
    await conv.appendCoordinatorConversation({
      id: `co:${messageId}`,
      role: 'coordinator',
      text: managerModel.line,
      ts: Date.now(),
      harness: true,
    })
    return { outcome: 'not-assisted', reason: managerModel.line, contractDigest: coordinatorContractDigest(), receipts: [] }
  }
  if (effective.resolution.effective !== 'agent-assisted' && managerModel === null) {
    const { getGlobalConfig, saveGlobalConfig } = await import('../../utils/config.js')
    if (getGlobalConfig().hasSeenCoordinatorOffHint !== true) {
      saveGlobalConfig(c => ({ ...c, hasSeenCoordinatorOffHint: true }))
      await conv.appendCoordinatorConversation({
        id: 'co:hint:coordinator-off',
        role: 'coordinator',
        text: 'coordinator is off — messages here start sessions directly · turn it on in the boot menu',
        ts: Date.now(),
        harness: true,
      })
    }
    return { kind: 'self-managed-launch', text: bounded }
  }
  {
    const modelForTurn =
      managerModel !== null && managerModel.ok
        ? managerModel.modelId
        : effective.resolution.effective === 'agent-assisted'
          ? effective.assistModelId
          : undefined
    if (modelForTurn !== undefined) {
      try {
        const compact = await import('./coordinatorCompact.js')
        const folded = await compact.maybeAutoCompactCoordinator(modelForTurn, {
          ...(deps.summarizeForCompact !== undefined ? { summarize: deps.summarizeForCompact } : {}),
        })
        if (folded.refused !== undefined) {
          logForDebugging(`[coordinator/auto-compact] refused — ${folded.refused}`)
        } else if (folded.compacted > 0) {
          logForDebugging(`[coordinator/auto-compact] ${folded.trigger}: folded ${folded.compacted} turns`)
        }
      } catch (e) {
        logForDebugging(`[coordinator/auto-compact] threw — ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  const receipt = await runAssistedTurn(
    { kind: 'operator-message', messageId, text: bounded },
    opts.manager === true
      ? { ...deps, manager: true, ...(managerModel !== null && managerModel.ok ? { managerModelId: managerModel.modelId } : {}) }
      : deps,
  )
  const receiptLines =
    receipt.receiptLabels ??
    receipt.receipts.map(r => ({ verb: r.verb, outcome: r.outcome, label: receiptLabelOf(r) }))
  if (receipt.outcome === 'deduped') return receipt
  let replyText: string
  let harnessSpoken = false
  if (receipt.reply !== undefined) {
    replyText = receipt.reply
  } else if (receipt.outcome === 'executed') {
    if (receipt.ask !== undefined) {
      replyText =
        receipt.ask.options.length > 0
          ? `${receipt.ask.question}\n${receipt.ask.options.map((option, index) => `  ${index + 1}. ${option}`).join('\n')}`
          : receipt.ask.question
    } else if (receipt.plan !== undefined) {
      replyText = `the plan is ready — ${receipt.plan.lanes.length} lane${receipt.plan.lanes.length === 1 ? '' : 's'} on the card below`
      harnessSpoken = true
    } else if (receipt.receipts.length > 0) {
      replyText = 'Done — the receipts below are what executed.'
      harnessSpoken = true
    } else if (receipt.smallestQuestion !== undefined) {
      replyText = receipt.smallestQuestion
    } else {
      replyText = 'The turn ended without a reply — nothing was changed. Ask again and I will answer from the board.'
      harnessSpoken = true
    }
  } else {
    replyText = `The turn did not run: ${receipt.reason ?? receipt.outcome}.`
    harnessSpoken = true
  }
  await conv.appendCoordinatorConversation({
    id: `co:${messageId}`,
    role: 'coordinator',
    text: replyText,
    ts: Date.now(),
    ...(receiptLines.length > 0 ? { receipts: receiptLines } : {}),
    ...(harnessSpoken ? { harness: true as const } : {}),
    ...(receipt.ask !== undefined ? { ask: receipt.ask } : {}),
    ...(receipt.plan !== undefined ? { plan: receipt.plan } : {}),
  })
  return receipt
}

export async function runCoordinatorTurn(
  event: KernelEventV1,
  deps: CoordinatorLaneDeps,
): Promise<AssistedTurnReceipt> {
  const effective = await resolveEffectiveCoordinator()
  if (effective.resolution.effective === 'agent-assisted') return runAssistedTurn(event, deps)
  if (effective.resolution.effective === 'off') {
    return { outcome: 'not-assisted', reason: 'coordinator off', contractDigest: coordinatorContractDigest(), receipts: [] }
  }
  const receipts = await runCoordinatorKernel(event, { ...deps, mode: 'rules-only' })
  return { outcome: 'executed', contractDigest: coordinatorContractDigest(), receipts }
}
