
import { join } from 'node:path'
import { defineStore } from '../../substrate/fileStore.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  activityIdOf,
  ingestActivity,
  registerActivityClassifier,
  type ActivityInput,
  type AgentActivityV1,
} from '../crew/activity.js'
import { crewStoreRoot, type CrewAgentId } from '../crew/identity.js'
import type { KernelReceiptV1 } from './coordinatorKernel.js'
import type { CoordinatorSwitchReceiptV1 } from './coordinatorModels.js'

export const COORDINATOR_EVENT_KIND = 'mercury.coordinator'
const ADAPTER = 'coordinator'
const FEED_SCOPE = 'concourse'

type CoordinatorFeedPayload =
  | { kind: 'action'; receipt: KernelReceiptV1 }
  | {
      kind: 'turn-refusal'
      reason: string
      refusedProposals?: number
      modelId?: string
      actorAgentId: string
    }
  | { kind: 'switch'; receipt: CoordinatorSwitchReceiptV1; actorAgentId: string }
  | { kind: 'smallest-question'; question: string; modelId?: string; actorAgentId: string }

let feedSeq = 0

function inputOf(payload: CoordinatorFeedPayload, actorAgentId: string, atMs: number): ActivityInput {
  return {
    event: {
      sourceEventId: `coordinator-${atMs}-${feedSeq++}`,
      kind: COORDINATOR_EVENT_KIND,
      payload,
      atMs,
    },
    agentId: actorAgentId as CrewAgentId,
    sessionId: FEED_SCOPE,
    adapterKind: ADAPTER,
  }
}

const ACTION_VERB: Record<KernelReceiptV1['verb'], string> = {
  'attention.raise': 'raised attention',
  'attention.supersede': 'superseded attention',
  'signal.emit': 'signaled',
  'session.pause': 'paused session',
  'session.resume': 'resumed session',
  'session.redirect': 'redirected session',
  'session.launch': 'launched session',
  'obligation.answer': 'answered question',
}

registerActivityClassifier({
  name: 'coordinator-receipt',
  precedence: 331,
  matches: input => input.event.kind === COORDINATOR_EVENT_KIND,
  lift: input => {
    const p = input.event.payload as CoordinatorFeedPayload
    const stamp = {
      activityId: activityIdOf(input),
      startedAt: input.event.atMs,
      updatedAt: input.event.atMs,
      evidenceRefs: [] as string[],
    }
    if (p.kind === 'action') {
      const r = p.receipt
      return {
        ...stamp,
        rawRefs: [`coordinator-receipt:${r.verb}:${r.objectRef}`],
        class: 'question',
        verb: ACTION_VERB[r.verb],
        objectLabel: r.objectRef.slice(0, 60),
        phase: r.outcome === 'refused' || r.outcome === 'failed' ? 'failed' : 'succeeded',
        outcomeLabel: `${r.outcome}${r.detail ? ` — ${r.detail}` : ''}`.slice(0, 80),
      }
    }
    if (p.kind === 'turn-refusal') {
      return {
        ...stamp,
        rawRefs: [`coordinator-receipt:turn-refusal`],
        class: 'question',
        verb: 'refused',
        objectLabel: p.reason.slice(0, 60),
        phase: 'cancelled',
        outcomeLabel: 'refused',
      }
    }
    if (p.kind === 'smallest-question') {
      return {
        ...stamp,
        rawRefs: [`coordinator-receipt:smallest-question`],
        class: 'question',
        verb: 'asked',
        objectLabel: p.question.slice(0, 60),
        phase: 'succeeded',
        outcomeLabel: 'awaiting the operator',
      }
    }
    const r = p.receipt
    return {
      ...stamp,
      rawRefs: [`coordinator-receipt:switch:${r.target}:${r.value}`],
      class: 'handoff',
      verb: r.target === 'mode' ? 'set coordinator mode' : 'switched coordinator model',
      objectLabel: r.value.slice(0, 60),
      phase: r.outcome === 'refused' ? 'failed' : 'succeeded',
      outcomeLabel: `${r.outcome}${r.reason ? ` — ${r.reason}` : r.detail ? ` — ${r.detail}` : ''}`.slice(0, 80),
    }
  },
})


interface ReceiptJournalRowV1 {
  seq: number
  pid: number
  atMs: number
  actorAgentId: string
  payload: CoordinatorFeedPayload
}

interface ReceiptJournalFileV1 {
  rows: ReceiptJournalRowV1[]
  nextSeq: number
  consumedSeq: number
}

const MAX_RECEIPT_JOURNAL_ROWS = 200

const receiptJournal = defineStore<ReceiptJournalFileV1, [dir?: string]>({
  name: 'coordinator-receipt-journal',
  path: (dir?: string) => join(crewStoreRoot(dir), 'coordinator-receipt-journal.json'),
  schemaVersion: 1,
  decode: raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as Partial<ReceiptJournalFileV1>
    return {
      rows: Array.isArray(r.rows) ? (r.rows.filter(x => x && typeof (x as ReceiptJournalRowV1).seq === 'number') as ReceiptJournalRowV1[]) : [],
      nextSeq: typeof r.nextSeq === 'number' ? r.nextSeq : 1,
      consumedSeq: typeof r.consumedSeq === 'number' ? r.consumedSeq : 0,
    }
  },
  empty: () => ({ rows: [], nextSeq: 1, consumedSeq: 0 }),
  onReadFailure: 'empty',
})

function journalPayload(payload: CoordinatorFeedPayload, actorAgentId: string, atMs: number, crewDir?: string): void {
  void receiptJournal(crewDir)
    .mutate(s => {
      const rows = [...s.rows, { seq: s.nextSeq, pid: process.pid, atMs, actorAgentId, payload }]
      return {
        rows: rows.length > MAX_RECEIPT_JOURNAL_ROWS ? rows.slice(-MAX_RECEIPT_JOURNAL_ROWS) : rows,
        nextSeq: s.nextSeq + 1,
        consumedSeq: s.consumedSeq,
      }
    })
    .catch(err => {
      logForDebugging(`[coordinator/receipts] journal append failed: ${err}`)
    })
}

const foldFailuresBySeq = new Map<number, number>()
const FOLD_RETRY_LIMIT = 2

export async function foldJournaledCoordinatorReceipts(opts: { crewDir?: string } = {}): Promise<number> {
  const store = receiptJournal(opts.crewDir)
  const state = await store.read()
  const unseen = state.rows.filter(r => r.seq > state.consumedSeq).sort((a, b) => a.seq - b.seq)
  let folded = 0
  let advanceTo = state.consumedSeq
  for (const row of unseen) {
    if (row.pid === process.pid) {
      advanceTo = row.seq
      continue
    }
    try {
      ingestActivity(inputOf(row.payload, row.actorAgentId, row.atMs))
      folded++
      advanceTo = row.seq
    } catch (err) {
      const failures = (foldFailuresBySeq.get(row.seq) ?? 0) + 1
      foldFailuresBySeq.set(row.seq, failures)
      if (failures < FOLD_RETRY_LIMIT) {
        logForDebugging(`[coordinator/receipts] journal fold failed at seq ${row.seq}: ${err} — the cursor stops here; the row is retried next fold`)
        break
      }
      logForDebugging(`[coordinator/receipts] journal row ${row.seq} failed ${failures} folds: ${err} — skipped`)
      advanceTo = row.seq
    }
  }
  if (advanceTo > state.consumedSeq) {
    await store.mutate(s => ({ ...s, consumedSeq: advanceTo }))
  }
  return folded
}

async function resolveActor(crewDir?: string): Promise<string> {
  try {
    const { coordinatorAgentId } = await import('./coordinatorIdentity.js')
    return await coordinatorAgentId(crewDir !== undefined ? { dir: crewDir } : undefined)
  } catch {
    return 'coordinator-unresolved'
  }
}

export async function ingestCoordinatorSmallestQuestion(i: {
  question: string
  modelId?: string
  actorAgentId?: string
  crewDir?: string
  atMs?: number
}): Promise<AgentActivityV1[]> {
  const actor = i.actorAgentId ?? (await resolveActor(i.crewDir))
  const atMs = i.atMs ?? Date.now()
  const payload: CoordinatorFeedPayload = {
    kind: 'smallest-question',
    question: i.question,
    ...(i.modelId !== undefined ? { modelId: i.modelId } : {}),
    actorAgentId: actor,
  }
  journalPayload(payload, actor, atMs, i.crewDir)
  return ingestActivity(inputOf(payload, actor, atMs))
}

const seenReceiptOps: string[] = []
export function ingestCoordinatorReceipts(
  receipts: readonly KernelReceiptV1[],
  opts: { atMs?: number; crewDir?: string } = {},
): AgentActivityV1[] {
  const atMs = opts.atMs ?? Date.now()
  const rows: AgentActivityV1[] = []
  for (const receipt of receipts) {
    if (receipt.opId !== undefined) {
      const key = `${receipt.verb} ${receipt.objectRef} ${receipt.opId} ${receipt.outcome}`
      if (seenReceiptOps.includes(key)) continue
      seenReceiptOps.push(key)
      if (seenReceiptOps.length > 200) seenReceiptOps.splice(0, seenReceiptOps.length - 200)
    }
    rows.push(...ingestActivity(inputOf({ kind: 'action', receipt }, receipt.actorAgentId, atMs)))
    journalPayload({ kind: 'action', receipt }, receipt.actorAgentId, atMs, opts.crewDir)
  }
  return rows
}

export async function ingestCoordinatorTurnRefusal(i: {
  reason: string
  refusedProposals?: number
  modelId?: string
  actorAgentId?: string
  crewDir?: string
  atMs?: number
}): Promise<AgentActivityV1[]> {
  const actor = i.actorAgentId ?? (await resolveActor(i.crewDir))
  const atMs = i.atMs ?? Date.now()
  const payload: CoordinatorFeedPayload = {
    kind: 'turn-refusal',
    reason: i.reason,
    ...(i.refusedProposals !== undefined ? { refusedProposals: i.refusedProposals } : {}),
    ...(i.modelId !== undefined ? { modelId: i.modelId } : {}),
    actorAgentId: actor,
  }
  journalPayload(payload, actor, atMs, i.crewDir)
  return ingestActivity(inputOf(payload, actor, atMs))
}

export async function ingestCoordinatorSwitchReceipt(
  receipt: CoordinatorSwitchReceiptV1,
  opts: { atMs?: number; crewDir?: string } = {},
): Promise<AgentActivityV1[]> {
  const atMs = opts.atMs ?? Date.now()
  journalPayload({ kind: 'switch', receipt, actorAgentId: 'operator' }, 'operator', atMs, opts.crewDir)
  return ingestActivity(inputOf({ kind: 'switch', receipt, actorAgentId: 'operator' }, 'operator', atMs))
}
