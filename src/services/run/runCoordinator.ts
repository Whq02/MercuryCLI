// ============================================================================
//  runCoordinator — owner-addressed run state: append, subscribe, persist,
//  reconcile, tear down.
//
//  The kernel (runKernel.ts) is the pure fold; this module owns everything
//  stateful around it:
//    · one bounded OwnerScopedStore of live runs;
//    · the effectObserver subscription (tool start/terminal → run events);
//    · deliverable sync FROM the real task store (never a second task DB);
//    · ONE per-owner persistence actor (persistenceActor.ts) for the
//      transcript-side sidecar — accepted vs committed generations, serial
//      ordering, a guaranteed trailing commit, the writer epoch, typed
//      degraded settlement and an awaited drain; lifecycle transitions commit
//      immediately, rapid progress coalesces, and ONLY main-lane substantive
//      runs persist (subagent lanes stay in-memory; workflow runs already have
//      their own manifests);
//    · resume reconciliation (sidecar ⇄ task state ⇄ verification ⇄
//      interrupted-tool markers) that never replays a terminal effect and
//      never fabricates a completed run.
// ============================================================================

import { randomUUID } from 'node:crypto'
// Side-effect imports: the ChangeReceipt observer and
// the Counsel auto-trigger ride the SAME effectObserver seam this
// coordinator consumes — run-state consumers, wired where run state wires.
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

/** Tools whose invocation marks a run substantive (work items / mutations). */
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
  /** THE durable writer for this owner. Owns generations, ordering,
   *  coalescing, the writer epoch, degraded settlement and the drain. */
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
  // Teardown DRAINS: the previous disposer released the coalesce timer and
  // nothing else, so an in-flight write and an accepted-but-uncommitted
  // snapshot were both dropped by explicit disposal and by LRU eviction.
  dispose: (state, owner) =>
    state.persistence.drain().then(settlement => {
      rememberDegraded(owner, settlement)
    }),
  // An owner with an uncommitted durable write is not a cache entry. Evicting
  // it would discard an accepted state change, so it is retained until its
  // write settles; the store reports the overflow instead of choosing a
  // victim when every live owner is in that position.
  retain: state => state.persistence.hasUncommittedWork(),
})
registerOwnerScopedStore(runs)

// ── subscriptions (UI reads; owner-tagged) ───────────────────────────────────
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
      /* subscriber errors never break the writer */
    }
  }
}

/** TEST-ONLY: live coordinator-owner count. */
export function _runOwnerCountForTesting(): number {
  return runs.size
}

// ── persistence ──────────────────────────────────────────────────────────────
function shouldPersist(owner: OwnerKey, snapshot: RunSnapshot): boolean {
  if (!snapshot.substantive) return false
  try {
    return parseOwnerKey(owner).lane === 'main'
  } catch {
    return false
  }
}

/**
 * Hand the current snapshot to the owner's writer as a new accepted
 * generation, and schedule its commit. Lifecycle transitions commit at once;
 * rapid progress coalesces, and the actor guarantees the NEWEST accepted
 * generation still gets its own commit.
 *
 * A run that does not persist (subagent lanes, non-substantive turns) simply
 * never accepts a generation — nothing is marked clean in advance of a write,
 * which is the property the old `state.dirty = false` broke.
 */
function acceptGeneration(owner: OwnerKey, state: CoordinatorState, immediate: boolean): void {
  if (!state.snapshot || !shouldPersist(owner, state.snapshot)) return
  state.persistence.accept(state.snapshot)
  state.persistence.schedule(immediate ? 0 : FLUSH_COALESCE_MS)
}

/** Force the atomic flush (terminal results, owner switch, checkpoints). */
export async function flushRun(owner: OwnerKey): Promise<void> {
  const state = runs.peek(owner)
  if (!state) return
  // Bind the settlement: a LIVE owner whose required write failed must appear
  // in degradedRunSettlements() too, not only one that failed during teardown.
  rememberDegraded(owner, await state.persistence.flush())
}

/**
 * Degraded settlements outlive their owner. A write that failed during
 * teardown is exactly the case with no live owner left to ask, so dropping the
 * receipt with the owner would reproduce the silence this replaces. Bounded:
 * only degraded settlements are kept, newest last.
 */
const DEGRADED_RECEIPT_CAP = 32
const degradedReceipts = new Map<OwnerKey, LaneSettlement>()

function rememberDegraded(owner: OwnerKey, settlement: LaneSettlement): void {
  if (settlement.state !== 'degraded') {
    // Only an actual landed commit clears the record. An owner KEY that is
    // re-created after a degraded teardown gets a fresh lane reading 'clean',
    // and a diagnostic read of that lane must not erase the receipt of the
    // write that was lost before it — reading a record cannot destroy it.
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

/**
 * The owner's durable settlement receipt: clean · pending · settled ·
 * degraded (with the reason and attempt count). A required persistence
 * failure is a fact a caller can read here — the previous code discarded the
 * write error in a bare catch, so an idle or terminal run lost the change with
 * nothing left to report it.
 */
export function runSettlement(owner: OwnerKey): LaneSettlement | null {
  const live = runs.peek(owner)?.persistence.settlement()
  if (live) {
    rememberDegraded(owner, live)
    return live
  }
  return degradedReceipts.get(owner) ?? null
}

/** Every owner whose last settlement was degraded (diagnostics, /health). */
export function degradedRunSettlements(): Array<{ owner: OwnerKey; settlement: LaneSettlement }> {
  return [...degradedReceipts].map(([owner, settlement]) => ({ owner, settlement }))
}

// ── event append ─────────────────────────────────────────────────────────────
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

// ── turn chokepoints (called from the shared query lifecycle) ────────────────

/**
 * A user request was accepted for this owner. Creates the run on first
 * contact, refreshes/reactivates a live run, and STARTS A NEW run after a
 * terminal one (a completed run's receipt is never mutated by a new ask).
 */
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

/**
 * The turn ended. Terminal mapping is explicit: an operator abort is a
 * CANCELLED run; an API error keeps the run active (retryable next turn) but
 * is recorded; a completed stop decision has already folded 'completed'.
 * Always force-flushes a dirty substantive run before returning.
 */
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

// ── deliverable sync (observe the REAL task store) ───────────────────────────
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

/**
 * Sync the run's deliverables from the real task list (diff → events).
 * Called at stop evaluation and on resume; failures degrade silently (the
 * evaluator then works from the last-known deliverable fold).
 */
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
  // Reverse pass: a
  // deliverable whose backing task no longer EXISTS in the ledger is DROPPED.
  // The 'deleted' arm above already encodes the intent, but listTasks can
  // never return a deleted/reset task — so a task that vanished between
  // syncs (the all-completed hide-timer reset, a model delete) froze its
  // deliverable open forever: the stop evaluator demanded work no tool
  // could reach, and the continuation capsule re-injected the phantom
  // across compaction. Only after a SUCCESSFUL read (a failed listTasks
  // returned above), and only open/in-progress transition — recorded
  // done/dropped history stands.
  //
  // MISMATCHED-CONTEXT GUARD: an
  // ALL-EMPTY read against a run holding open deliverables is ambiguous —
  // either a real full reset, or a caller whose task-list id resolves
  // differently from the transcript's session (an out-of-session reconcile),
  // where the drop would destroy live plan state AND flush the damage. A
  // genuine reset bumps the durable task EPOCH first (FC6), so epoch 0 +
  // zero tasks + open deliverables reads as the mismatched context: skip the
  // reverse pass, keep the recorded plan.
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

/** Refresh the run's verification fold from the owner's evidence model. */
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
    /* evidence unavailable — keep the last fold */
  }
}

// ── resume reconciliation ────────────────────────────────────────
export type RunReconcileResult =
  | { state: 'none' }
  | { state: 'recoverable'; reason: string }
  | { state: 'reconciled'; snapshot: RunSnapshot }
  | { state: 'terminal'; snapshot: RunSnapshot }
  /** The sidecar could not be read at all, so whether a run exists is UNKNOWN
   * never the same answer as `none`. */
  | { state: 'unavailable'; reason: string; retryable: boolean }

/**
 * Reconcile a resumed owner with its sidecar: validate, mark interruption,
 * re-sync task + verification state, choose the next action from the fold,
 * and persist the reconciled snapshot BEFORE any continuation decision.
 * Never replays a terminal effect; never reruns completed deliverables;
 * never calls an interrupted mutation successful.
 */
export async function reconcileOnResume(owner: OwnerKey, cwd: string): Promise<RunReconcileResult> {
  // CLOBBER GUARD: the sidecar load spans
  // an await — a prompt landing in that window creates a FRESH live run via
  // acceptUserRequest, and the pre-guard assignment below would replace it
  // with yesterday's disk state. A run that appeared while we were loading
  // owns the owner; the reconcile stands down.
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
    // A finished run is a receipt — never reactivated by mere resume.
    return { state: 'terminal', snapshot: load.snapshot }
  }
  const at = Date.now()
  // The process died (or was interrupted) with the run non-terminal: every
  // tool started without a terminal effect is INTERRUPTED/indeterminate —
  // the pendingTools markers survive in the fold and the evaluator forces an
  // inspect-reconcile step before completion can be claimed.
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
  // BLOCKED PRESERVATION: the 'resumed'
  // fold clears the blocker — right for the in-session switch (operator
  // input), wrong for merely reopening the app: an unanswered operator
  // blocker must survive the restart or the fact silently vanishes from
  // every surface. Re-emit the loaded blocker; a real operator ANSWER still
  // clears it through request-accepted.
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

// ── the interactive boot fold (FN-013 CRASH-02) ─────────────────────────────
// The run-level fold used to run on the print/SDK and /run roads only; an
// interactive --resume after a crash got the synthetic continuation prompt
// and none of the uncertainty markers — identical sidecar bytes yielded
// different fidelity depending on surface, and the default surface was the
// weaker one. The interactive launch calls THIS wrapper (replLauncher,
// after runBootRecovery with the session id final): the same fold exactly
// once, degrading to the current boot with a logged typed reason on any
// failure, plus a one-shot notice latch the REPL's boot effect paints so
// the interruption count and a re-emitted blocker are visible in the chat.

export type ResumeFoldNotice = {
  /** Tool calls that died mid-flight (the fold's uncertainty markers). */
  interruptedTools: number
  /** The re-emitted operator blocker, when the loaded run was blocked. */
  blocker: RunBlocker | null
}
let resumeFoldNotice: ResumeFoldNotice | null = null

/** Consume the one-shot boot-fold notice (null when nothing was folded, a
 *  fresh launch included — its owner has no sidecar, so no fold runs). */
export function takeResumeFoldNotice(): ResumeFoldNotice | null {
  const notice = resumeFoldNotice
  resumeFoldNotice = null
  return notice
}

/**
 * The interactive launch's run-level fold: exactly the print-road shape
 * (fold only when the kernel holds no live run for the owner), so print
 * mode and an interactive resume produce the same folded snapshot from
 * byte-identical sidecar input. Never throws — a failed fold is a logged
 * typed reason and the boot proceeds with today's behaviour.
 */
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

// ── the effect-observer feed (module-init wiring) ────────────────────────────
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
  // every settled call records ONE normalized attempt before
  // its effect folds — a succeeding effect's progress then re-arms the
  // repeat judgment (order matters: attempt first, effect second).
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
  // Legacy tools (no typed effect): a resolved mutating tool is a succeeded
  // write of its declared path; failures fold as failed effects so the
  // evaluator sees them. Reads fold as no-change observations only when the
  // run cares (skip to keep the event tail signal-dense).
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
    // Non-substantive legacy tool: clear its pending marker without growing
    // the effect tail.
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
