
import { randomUUID } from 'node:crypto'
import '../changeTransaction/receipts.js'
import '../counsel/counsel.js'
import { logError } from '../../utils/log.js'
import { getTaskListId, listTasks } from '../../utils/tasks.js'
import { verificationSummary } from '../../utils/verification/verificationState.js'
import { subscribeToolStart, subscribeToolTerminal } from './effectObserver.js'
import { makeAttemptFingerprint } from './progressModel.js'
import { parseOwnerKey, type OwnerKey } from './ownerKey.js'
import { registerOwnerScopedStore } from './ownerLifecycle.js'
import { OwnerScopedStore } from './ownerScopedStore.js'
import { ownerPersistence, type OwnerPersistence } from './persistenceActor.js'
import type { LaneSettlement } from '../../substrate/serialGeneration.js'
import {
  emptyRunSnapshot,
  isTerminalLifecycle,
  reduceRunEvent,
  type DeliverableState,
  type RunBlocker,
  type RunEvent,
  type RunSnapshot,
} from './runKernel.js'
import { loadRunSidecar, saveRunSidecar, type RunSidecarLoad } from './runSidecar.js'

const FLUSH_COALESCE_MS = 250

const SUBSTANTIVE_TOOLS = new Set([
  'Edit',
  'Write',
  'NotebookEdit',
  'MultiEdit',
  'TaskCreate',
  'TaskUpdate',
])

interface CoordinatorState {
  snapshot: RunSnapshot | null
  persistence: OwnerPersistence<RunSnapshot>
}

const runs = new OwnerScopedStore<CoordinatorState>({
  name: 'run-coordinator',
  create: owner => ({
    snapshot: null,
    persistence: ownerPersistence<RunSnapshot>({
      name: 'run-sidecar',
      owner,
      commit: (o, snapshot, ctx) =>
        saveRunSidecar(o, snapshot, { epoch: ctx.epoch, writerId: ctx.writerId }),
    }),
  }),
  dispose: (state, owner) =>
    state.persistence.drain().then(settlement => {
      rememberDegraded(owner, settlement)
    }),
  retain: state => state.persistence.hasUncommittedWork(),
})
registerOwnerScopedStore(runs)

type RunSubscriber = (owner: OwnerKey) => void
const subscribers = new Set<RunSubscriber>()

export function subscribeRuns(cb: RunSubscriber): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

function notify(owner: OwnerKey): void {
  for (const cb of subscribers) {
    try {
      cb(owner)
    } catch {
    }
  }
}

export function _runOwnerCountForTesting(): number {
  return runs.size
}

function shouldPersist(owner: OwnerKey, snapshot: RunSnapshot): boolean {
  if (!snapshot.substantive) return false
  try {
    return parseOwnerKey(owner).lane === 'main'
  } catch {
    return false
  }
}

function acceptGeneration(owner: OwnerKey, state: CoordinatorState, immediate: boolean): void {
  if (!state.snapshot || !shouldPersist(owner, state.snapshot)) return
  state.persistence.accept(state.snapshot)
  state.persistence.schedule(immediate ? 0 : FLUSH_COALESCE_MS)
}

export async function flushRun(owner: OwnerKey): Promise<void> {
  const state = runs.peek(owner)
  if (!state) return
  rememberDegraded(owner, await state.persistence.flush())
}

const DEGRADED_RECEIPT_CAP = 32
const degradedReceipts = new Map<OwnerKey, LaneSettlement>()

function rememberDegraded(owner: OwnerKey, settlement: LaneSettlement): void {
  if (settlement.state !== 'degraded') {
    if (settlement.state === 'settled') degradedReceipts.delete(owner)
    return
  }
  degradedReceipts.delete(owner)
  degradedReceipts.set(owner, settlement)
  while (degradedReceipts.size > DEGRADED_RECEIPT_CAP) {
    const oldest = degradedReceipts.keys().next().value as OwnerKey | undefined
    if (oldest === undefined) break
    degradedReceipts.delete(oldest)
  }
}

export function runSettlement(owner: OwnerKey): LaneSettlement | null {
  const live = runs.peek(owner)?.persistence.settlement()
  if (live) {
    rememberDegraded(owner, live)
    return live
  }
  return degradedReceipts.get(owner) ?? null
}

export function degradedRunSettlements(): Array<{ owner: OwnerKey; settlement: LaneSettlement }> {
  return [...degradedReceipts].map(([owner, settlement]) => ({ owner, settlement }))
}

const LIFECYCLE_EVENT_TYPES = new Set<RunEvent['type']>([
  'request-accepted',
  'blocked',
  'paused',
  'resumed',
  'interrupted',
  'cancelled',
  'failed',
  'completed',
])

export function noteRunEvent(owner: OwnerKey, event: RunEvent): void {
  const state = runs.get(owner)
  if (!state.snapshot) return
  state.snapshot = reduceRunEvent(state.snapshot, event)
  acceptGeneration(owner, state, LIFECYCLE_EVENT_TYPES.has(event.type))
  notify(owner)
}

export function getRunSnapshot(owner: OwnerKey): RunSnapshot | null {
  return runs.peek(owner)?.snapshot ?? null
}


export function acceptUserRequest(
  owner: OwnerKey,
  req: { objective: string; rootMessageId: string | null },
): RunSnapshot {
  const state = runs.get(owner)
  const at = Date.now()
  if (!state.snapshot || isTerminalLifecycle(state.snapshot.lifecycle)) {
    state.snapshot = emptyRunSnapshot({
      runId: randomUUID(),
      owner,
      objective: req.objective,
      rootMessageId: req.rootMessageId,
      at,
    })
    acceptGeneration(owner, state, false)
    notify(owner)
    return state.snapshot
  }
  state.snapshot = reduceRunEvent(state.snapshot, {
    type: 'request-accepted',
    at,
    objective: req.objective,
    rootMessageId: req.rootMessageId,
  })
  acceptGeneration(owner, state, true)
  notify(owner)
  return state.snapshot
}

export async function noteTurnEnd(
  owner: OwnerKey,
  outcome: { reason: string; aborted: boolean },
): Promise<void> {
  const state = runs.peek(owner)
  if (!state?.snapshot) return
  const snap = state.snapshot
  if (outcome.aborted && !isTerminalLifecycle(snap.lifecycle)) {
    state.snapshot = reduceRunEvent(snap, {
      type: 'cancelled',
      at: Date.now(),
      reason: 'operator interrupt',
    })
    acceptGeneration(owner, state, true)
    notify(owner)
  } else if (outcome.reason === 'model_error' && !isTerminalLifecycle(snap.lifecycle)) {
    state.snapshot = reduceRunEvent(snap, {
      type: 'stop-decision',
      at: Date.now(),
      decision: 'api-error',
      detail: 'turn ended on an API error — run stays active, no continuation',
    })
    acceptGeneration(owner, state, true)
    notify(owner)
  }
  await flushRun(owner)
}

function taskStatusToDeliverable(status: string): DeliverableState {
  switch (status) {
    case 'completed':
      return 'done'
    case 'in_progress':
      return 'in-progress'
    case 'deleted':
      return 'dropped'
    default:
      return 'open'
  }
}

export async function syncDeliverablesFromTasks(owner: OwnerKey): Promise<void> {
  const state = runs.peek(owner)
  if (!state?.snapshot) return
  let tasks: Awaited<ReturnType<typeof listTasks>>
  try {
    tasks = await listTasks(getTaskListId())
  } catch {
    return
  }
  for (const task of tasks) {
    const mapped = taskStatusToDeliverable(task.status)
    const existing = state.snapshot.deliverables.find(d => d.id === task.id)
    if (!existing || existing.state !== mapped || existing.title !== task.subject) {
      noteRunEvent(owner, {
        type: 'task-transition',
        at: Date.now(),
        taskId: task.id,
        title: task.subject,
        state: mapped,
      })
    }
  }
  if (tasks.length === 0 && state.snapshot.deliverables.some(d => d.state === 'open' || d.state === 'in-progress')) {
    try {
      const { readTaskEpoch } = await import('../../utils/tasks.js')
      if ((await readTaskEpoch(getTaskListId())) === 0) return
    } catch {
      return
    }
  }
  const live = new Set(tasks.map(t => t.id))
  const snap = runs.peek(owner)?.snapshot
  if (!snap) return
  for (const d of snap.deliverables) {
    if (!live.has(d.id) && (d.state === 'open' || d.state === 'in-progress')) {
      noteRunEvent(owner, {
        type: 'task-transition',
        at: Date.now(),
        taskId: d.id,
        title: d.title,
        state: 'dropped',
      })
    }
  }
}

export function syncVerification(owner: OwnerKey, cwd: string): void {
  const state = runs.peek(owner)
  if (!state?.snapshot) return
  try {
    const s = verificationSummary(cwd, { skipDigest: true, owner })
    if (
      state.snapshot.verification.state !== s.state ||
      state.snapshot.verification.detail !== s.detail
    ) {
      noteRunEvent(owner, {
        type: 'evidence',
        at: Date.now(),
        state: s.state,
        detail: s.detail,
      })
    }
  } catch {
  }
}

export type RunReconcileResult =
  | { state: 'none' }
  | { state: 'recoverable'; reason: string }
  | { state: 'reconciled'; snapshot: RunSnapshot }
  | { state: 'terminal'; snapshot: RunSnapshot }
  | { state: 'unavailable'; reason: string; retryable: boolean }

export async function reconcileOnResume(owner: OwnerKey, cwd: string): Promise<RunReconcileResult> {
  const before = runs.peek(owner)?.snapshot ?? null
  const load: RunSidecarLoad = await loadRunSidecar(owner)
  if ((runs.peek(owner)?.snapshot ?? null) !== before) {
    return { state: 'none' }
  }
  if (load.state === 'none') return { state: 'none' }
  if (load.state === 'unavailable') {
    return { state: 'unavailable', reason: load.reason, retryable: load.retryable }
  }
  if (load.state === 'recoverable') {
    return { state: 'recoverable', reason: load.reason }
  }
  const state = runs.get(owner)
  state.snapshot = load.snapshot
  if (isTerminalLifecycle(load.snapshot.lifecycle)) {
    return { state: 'terminal', snapshot: load.snapshot }
  }
  const at = Date.now()
  state.snapshot = reduceRunEvent(state.snapshot, {
    type: 'interrupted',
    at,
    reason:
      load.snapshot.pendingTools.length > 0
        ? `resumed with ${load.snapshot.pendingTools.length} tool call(s) interrupted mid-flight`
        : 'resumed after interruption',
  })
  state.snapshot = reduceRunEvent(state.snapshot, {
    type: 'resumed',
    at,
    reason: 'session resumed — state reconciled before continuing',
  })
  if (load.snapshot.lifecycle === 'blocked' && load.snapshot.blocker) {
    state.snapshot = reduceRunEvent(state.snapshot, {
      type: 'blocked',
      at,
      blocker: load.snapshot.blocker,
    })
  }
  acceptGeneration(owner, state, false)
  await syncDeliverablesFromTasks(owner)
  syncVerification(owner, cwd)
  const snap = state.snapshot
  const nextOpen = snap.deliverables.find(d => d.state === 'open' || d.state === 'in-progress')
  noteRunEvent(owner, {
    type: 'next-action',
    at: Date.now(),
    action:
      snap.pendingTools.length > 0
        ? `inspect the interrupted ${snap.pendingTools[0]!.toolName} call's real state before retrying`
        : nextOpen
          ? `continue the open deliverable: ${nextOpen.title || nextOpen.id}`
          : snap.verification.state !== 'verified'
            ? 'verify the current tree, then close out'
            : 'confirm completion against the objective',
  })
  await flushRun(owner)
  notify(owner)
  return { state: 'reconciled', snapshot: state.snapshot! }
}


export type ResumeFoldNotice = {
  interruptedTools: number
  blocker: RunBlocker | null
}
let resumeFoldNotice: ResumeFoldNotice | null = null

export function takeResumeFoldNotice(): ResumeFoldNotice | null {
  const notice = resumeFoldNotice
  resumeFoldNotice = null
  return notice
}

export async function foldResumedRunForBoot(owner: OwnerKey, cwd: string): Promise<RunReconcileResult> {
  try {
    if (getRunSnapshot(owner) !== null) return { state: 'none' }
    const result = await reconcileOnResume(owner, cwd)
    if (result.state === 'unavailable' || result.state === 'recoverable') {
      logError(new Error(`resume run fold degraded (${result.state}): ${result.reason} — continuing without the fold`))
    }
    if (result.state === 'reconciled') {
      const interruptedTools = result.snapshot.pendingTools.length
      const blocker = result.snapshot.lifecycle === 'blocked' ? result.snapshot.blocker : null
      if (interruptedTools > 0 || blocker !== null) {
        resumeFoldNotice = { interruptedTools, blocker }
      }
    }
    return result
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    logError(new Error(`resume run fold failed: ${reason} — continuing without the fold`))
    return { state: 'unavailable', reason, retryable: false }
  }
}

subscribeToolStart(event => {
  const state = runs.peek(event.owner)
  if (!state?.snapshot || isTerminalLifecycle(state.snapshot.lifecycle)) return
  noteRunEvent(event.owner, {
    type: 'tool-started',
    at: Date.now(),
    toolName: event.toolName,
    toolUseId: event.toolUseId,
  })
  if (SUBSTANTIVE_TOOLS.has(event.toolName) && !state.snapshot.substantive) {
    noteRunEvent(event.owner, {
      type: 'substantive',
      at: Date.now(),
      reason: `invoked ${event.toolName}`,
    })
  }
})

subscribeToolTerminal(event => {
  const state = runs.peek(event.owner)
  if (!state?.snapshot || isTerminalLifecycle(state.snapshot.lifecycle)) return
  noteRunEvent(event.owner, {
    type: 'attempt',
    at: Date.now(),
    toolUseId: event.toolUseId,
    fingerprint: makeAttemptFingerprint({
      toolName: event.toolName,
      input: event.input,
      cwd: event.cwd,
    }),
  })
  if (event.effect) {
    noteRunEvent(event.owner, {
      type: 'tool-effected',
      at: Date.now(),
      toolName: event.toolName,
      toolUseId: event.toolUseId,
      operation: event.effect.operation,
      outcome: event.effect.outcome,
      changedPaths: event.effect.changedPaths,
    })
    return
  }
  const input = event.input as { file_path?: unknown; notebook_path?: unknown } | undefined
  const declaredPath =
    typeof input?.file_path === 'string'
      ? input.file_path
      : typeof input?.notebook_path === 'string'
        ? input.notebook_path
        : undefined
  if (SUBSTANTIVE_TOOLS.has(event.toolName)) {
    noteRunEvent(event.owner, {
      type: 'tool-effected',
      at: Date.now(),
      toolName: event.toolName,
      toolUseId: event.toolUseId,
      operation: event.toolName.toLowerCase(),
      outcome: event.ok ? 'succeeded' : 'failed',
      changedPaths: event.ok && declaredPath ? [declaredPath] : [],
    })
  } else {
    noteRunEvent(event.owner, {
      type: 'tool-effected',
      at: Date.now(),
      toolName: event.toolName,
      toolUseId: event.toolUseId,
      operation: event.toolName.toLowerCase(),
      outcome: event.ok ? 'no-change' : 'failed',
      changedPaths: [],
    })
  }
})
