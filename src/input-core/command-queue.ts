// ============================================================================
//  input-core/command-queue.ts — S1: the follow-up
//  command queue, owned.
//
//  ONE unified queue for everything the ENGINE reads at its next readable
//  moment — user prompts, task notifications, orphaned permissions. This
//  is invisible transport inside a session's own runner (the headless turn
//  driver, the TurnMachine's mid-turn drain), plus the cockpit-process
//  parking for attention dispatches: THE STEER-REMOVAL RULING removed the
//  operator-facing pen whole (the queue strip, the steering hint, Tab-hold,
//  restage chords, queue editing, pop-to-composer) — a sent message is
//  delivered instantly and read at the next legal boundary, exactly once,
//  so nothing here is an operator surface any more. The QUEUE-LAWS checks
//  in scripts/core-runtime/prove-inputsched-contract.ts ARE this module's
//  contract; the quirks below are pinned there deliberately.
//
//  The laws, stated once:
//  • PRIORITY — now > next > later; FIFO within a band. `enqueue` defaults
//    'next' (user input — the earliest boundary), `enqueuePendingNotification`
//    defaults 'later' (system messages never starve typing).
//  • CLONE-ON-ENQUEUE — queue identity is MINTED here (the entry is a
//    spread of the caller's object, stamped with a stable `queueId`).
//    remove() works strictly by queue-obtained reference identity: a
//    caller passing its original object is a silent no-op — only
//    references from getDrainableCommands/getCommandQueue/snapshot
//    remove. The TurnMachine's exactly-once drain rides this reference
//    identity (protected by the drain marks).
//  • IMMUTABLE RECORDS — the queue never mutates a record after minting
//    it (the useSyncExternalStore contract): previously returned frozen
//    snapshots never change retroactively.
//  • ONE NOTIFICATION PER MUTATION — every mutating operation re-freezes
//    the snapshot and emits exactly once (a no-hit remove neither
//    notifies nor rerolls the snapshot).
//  • QUIRK (contract, do not "fix" silently): dequeueAllMatching
//    returns matches in INSERTION order, not priority order.
// ============================================================================
import type { ContentBlockParam } from '../types/wire.js'
import type { Permutations } from 'src/types/utils.js'
import { getSessionId } from '../bootstrap/state.js'
import type { AppState } from '../state/AppState.js'
import type {
  QueueOperation,
  QueueOperationMessage,
} from '../types/messageQueueTypes.js'
import type {
  EditablePromptInputMode,
  PromptInputMode,
  QueuedCommand,
  QueuePriority,
} from '../types/textInputTypes.js'
import { type PastedContent } from '../utils/config.js'
// Leaf import (not the utils/messages barrel): the barrel's graph reaches
// back into queue consumers — a barrel import here is a TDZ cycle (§DEPS-TDZ).
import { extractTextContent } from '../utils/messages/text.js'
import { objectGroupBy } from '../utils/objectGroupBy.js'
import { recordQueueOperation } from '../utils/sessionStorage.js'
import { createSignal } from '../utils/signal.js'

export type SetAppState = (f: (prev: AppState) => AppState) => void

// ── the store ────────────────────────────────────────────────────────────────

const queue: QueuedCommand[] = []
/** Frozen snapshot — recreated on every mutation for useSyncExternalStore. */
let snapshot: readonly QueuedCommand[] = Object.freeze([])
const queueChanged = createSignal()

/** Stable queue identity, minted at the clone-on-enqueue sites. Survives a
 *  restage's immutable record replacement. */
let queueIdSeq = 0
function mintQueueId(): string {
  return `q${++queueIdSeq}`
}

/** The one mutation-commit seam: re-freeze the snapshot, emit once. */
function commit(): void {
  snapshot = Object.freeze([...queue])
  queueChanged.emit()
}

// ── consumption provenance ──────────────────────────────────────
//  A SEPARATE typed channel beside the change signal: WHY commands left the
//  queue. 'dequeued' = consumed for execution (idle drain / driver);
//  'removed' = reference-identity removal (the mid-turn steering drain — its
//  uuids also fire lifecycle 'started'); 'cleared' = ESC discard (and
//  replace-next's discarded target — an operator discard-and-substitute);
//  'popped' = pulled back into the composer. Consumers classify on these —
//  dequeued/removed-with-started mean the command RAN; cleared/popped mean it
//  did NOT (and must never read as executed). The QUEUE-LAWS notification
//  contract (one queueChanged emit per mutation) is untouched.

export type QueueConsumptionEvent = {
  kind: 'dequeued' | 'removed' | 'cleared' | 'popped'
  commands: readonly QueuedCommand[]
}

type QueueConsumptionListener = (event: QueueConsumptionEvent) => void
const consumptionListeners = new Set<QueueConsumptionListener>()

/** Subscribe to consumption provenance. Returns remove. */
export function subscribeQueueConsumption(cb: QueueConsumptionListener): () => void {
  consumptionListeners.add(cb)
  return () => consumptionListeners.delete(cb)
}

function emitConsumption(kind: QueueConsumptionEvent['kind'], commands: readonly QueuedCommand[]): void {
  if (commands.length === 0 || consumptionListeners.size === 0) return
  const event: QueueConsumptionEvent = { kind, commands }
  for (const l of consumptionListeners) {
    try {
      l(event)
    } catch {
      // a consumption listener must never break the queue
    }
  }
}

/** The session queue-operation journal (transcript-adjacent, fire-and-forget). */
function logOperation(operation: QueueOperation, content?: string): void {
  const queueOp: QueueOperationMessage = {
    type: 'queue-operation',
    operation,
    timestamp: new Date().toISOString(),
    sessionId: getSessionId(),
    ...(content !== undefined && { content }),
  }
  void recordQueueOperation(queueOp)
}

const PRIORITY_ORDER: Record<QueuePriority, number> = {
  now: 0,
  next: 1,
  later: 2,
}

/** The one priority scan (the old body wrote it twice, in dequeue and
 *  peek): the index of the first command in the highest-priority band that
 *  passes the filter, or -1. FIFO within a band falls out of first-wins. */
function bestIndexByPriority(
  filter?: (cmd: QueuedCommand) => boolean,
): number {
  let bestIdx = -1
  let bestPriority = Infinity
  for (let i = 0; i < queue.length; i++) {
    const cmd = queue[i]!
    if (filter && !filter(cmd)) continue
    const priority = PRIORITY_ORDER[cmd.priority ?? 'next']
    if (priority < bestPriority) {
      bestIdx = i
      bestPriority = priority
    }
  }
  return bestIdx
}

// ── useSyncExternalStore interface ───────────────────────────────────────────

/** Subscribe to queue changes (useSyncExternalStore-compatible). */
export const subscribeToCommandQueue = queueChanged.subscribe

/** The frozen snapshot — reference changes only on mutation. */
export function getCommandQueueSnapshot(): readonly QueuedCommand[] {
  return snapshot
}

// ── reads (non-React drivers) ────────────────────────────────────────────────

/** A mutable copy for one-off reads. */
export function getCommandQueue(): QueuedCommand[] {
  return [...queue]
}

/**
 * Commands at or above a priority threshold, WITHOUT removing them — the
 * queue's own object references (the mid-turn drain removes by exactly
 * these identities). 'now' returns only now-band; 'later' returns all.
 */
function getCommandsByMaxPriority(
  maxPriority: QueuePriority,
): QueuedCommand[] {
  const threshold = PRIORITY_ORDER[maxPriority]
  return queue.filter(
    cmd => PRIORITY_ORDER[cmd.priority ?? 'next'] <= threshold,
  )
}

/**
 * The mid-turn drain's view of the queue. At a Sleep boundary the 'later'
 * band joins for TASK NOTIFICATIONS only: a notification's whole purpose is
 * to wake the waiting turn, while a prompt the operator explicitly held with
 * Tab keeps its promise — "waits for the next turn" — whatever the turn does.
 * (Before HZ4 the later band held only notifications, so the plain
 * band widening was safe; once Tab staged operator prompts there, widening
 * on sleepRan silently folded a held prompt into the running turn.)
 */
export function getDrainableCommands(sleepBoundary: boolean): QueuedCommand[] {
  if (!sleepBoundary) return getCommandsByMaxPriority('next')
  const nextThreshold = PRIORITY_ORDER['next']
  return queue.filter(cmd => {
    if (PRIORITY_ORDER[cmd.priority ?? 'next'] <= nextThreshold) return true
    return cmd.mode === 'task-notification'
  })
}

/** Queue-obtained references the TurnMachine has snapshotted for the drain
 *  it is CURRENTLY producing attachments for. Replaced wholesale at each
 *  selection; the session re-key leaves these live (the drain corner below)
 *  so the turn machine's exactly-once remove always finds them. */
let drainingNow: ReadonlySet<QueuedCommand> = new Set()

export function markDraining(commands: readonly QueuedCommand[]): void {
  drainingNow = new Set(commands)
}

// ── the session re-key (AGENTDIALS C6 — Law 9: the queue is the session's) ──
//  The ONE live queue serves the FOCUSED session. Before this, the store had
//  no session key: words typed while A was busy were drained by the NEXT
//  turn of whichever session was focused — a human gesture (type-while-busy,
//  hop, B's turn starts) fired A's queued words into B. The W4 idiom
//  (pending-input rekeyToSession's sibling): the REPL's hop effect re-keys
//  this store at the slot swap — the live entries PARK whole under the
//  outgoing owner (band order and minted queueIds preserved, so a return
//  restores them byte-identical) and the incoming owner's parked entries
//  come back, ONE commit per swap (the notification law holds). The
//  same-session road is byte-identical: no swap ⇒ nothing here runs, and
//  every QUEUE-LAWS check stands untouched. The owner falls back to the
//  bootstrap id before the first swap (pending-input's own pre-concourse
//  key), so the initial session's words park under a real identity.
//
//  THE DRAIN CORNER (ruled bound): entries in drainingNow STAY in the live
//  queue at a swap — the outgoing turn machine holds their queue-obtained
//  references and its exactly-once remove must find them; parking them
//  would no-op that remove and RESURRECT consumed words on the next return.
//  remove() sweeps the parked banks defensively for the same reason.
//
//  NAMED NON-GOAL (ruled): notification ADDRESSING stays arrival-time — a
//  task spawned under A that completes while B is focused still enqueues
//  into the live (B's) queue, exactly as before this change; per-enqueue
//  session identity at every call site is a future lane, not this rider.
let owningSessionId: string | null = null
const parkedQueues = new Map<string, QueuedCommand[]>()

export function rekeyCommandQueueToSession(sessionId: string | null, opts?: { landing?: boolean }): void {
  const prevKey = owningSessionId ?? getSessionId()
  const nextKey = sessionId ?? getSessionId()
  owningSessionId = sessionId
  if (nextKey === prevKey) return
  // A LANDING is not a hop: the slot filling from NO session (a birth, a
  // resume from the face) keeps the entries queued while it landed — they
  // were queued for the chat that is arriving, and parking them under the
  // bootstrap identity would leave them unreachable (nothing re-keys back
  // to it in the hosted world). The caller names the landing: the queue's
  // owner at boot is the bootstrap identity, which is also a live
  // session's own id in the plain world, so the owner alone cannot tell.
  if (opts?.landing === true) {
    const returning = parkedQueues.get(nextKey)
    if (returning !== undefined) {
      parkedQueues.delete(nextKey)
      if (returning.length > 0) {
        queue.push(...returning)
        commit()
      }
    }
    return
  }
  let moved = false
  // Park the outgoing session's entries whole (drainingNow stays live —
  // the corner above); order within the bank is queue order.
  const parked: QueuedCommand[] = []
  for (let i = queue.length - 1; i >= 0; i--) {
    if (!drainingNow.has(queue[i]!)) parked.unshift(queue.splice(i, 1)[0]!)
  }
  if (parked.length > 0) {
    const bank = parkedQueues.get(prevKey)
    if (bank) bank.push(...parked)
    else parkedQueues.set(prevKey, parked)
    moved = true
  }
  // Restore the incoming session's parked entries, identities intact.
  const returning = parkedQueues.get(nextKey)
  if (returning !== undefined) {
    parkedQueues.delete(nextKey)
    if (returning.length > 0) {
      queue.push(...returning)
      moved = true
    }
  }
  if (moved) commit()
}

/** The highest-priority command without removal (optional filter). */
export function peek(
  filter?: (cmd: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  const idx = bestIndexByPriority(filter)
  return idx === -1 ? undefined : queue[idx]
}

// ── writes ───────────────────────────────────────────────────────────────────

/** User-initiated commands (prompt, bash, orphaned-permission).
 *  Defaults priority 'next'. Queue identity is minted HERE (clone). */
export function enqueue(command: QueuedCommand): void {
  queue.push({
    ...command,
    priority: command.priority ?? 'next',
    queueId: mintQueueId(),
  })
  commit()
  logOperation(
    'enqueue',
    typeof command.value === 'string' ? command.value : undefined,
  )
}

/** Task notifications — defaults 'later' so user input is never starved. */
export function enqueuePendingNotification(command: QueuedCommand): void {
  queue.push({
    ...command,
    priority: command.priority ?? 'later',
    queueId: mintQueueId(),
  })
  commit()
  logOperation(
    'enqueue',
    typeof command.value === 'string' ? command.value : undefined,
  )
}

/** Remove + return the highest-priority command (FIFO within a band).
 *  The optional filter narrows candidates; non-matching commands stay
 *  untouched — between-turn drains restrict to main-thread commands
 *  without restructuring their while-loop shape. */
export function dequeue(
  filter?: (cmd: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  const idx = bestIndexByPriority(filter)
  if (idx === -1) return undefined
  const [dequeued] = queue.splice(idx, 1)
  commit()
  logOperation('dequeue')
  emitConsumption('dequeued', dequeued ? [dequeued] : [])
  return dequeued
}

/** Remove + return everything (one journal row per command). */
export function dequeueAll(): QueuedCommand[] {
  if (queue.length === 0) {
    return []
  }
  const commands = [...queue]
  queue.length = 0
  commit()
  for (const _cmd of commands) {
    logOperation('dequeue')
  }
  emitConsumption('dequeued', commands)
  return commands
}

/** Remove + return all matches. QUIRK (pinned): matches return in
 *  INSERTION order, not priority order. */
export function dequeueAllMatching(
  predicate: (cmd: QueuedCommand) => boolean,
): QueuedCommand[] {
  const matched: QueuedCommand[] = []
  const remaining: QueuedCommand[] = []
  for (const cmd of queue) {
    if (predicate(cmd)) {
      matched.push(cmd)
    } else {
      remaining.push(cmd)
    }
  }
  if (matched.length === 0) {
    return []
  }
  queue.length = 0
  queue.push(...remaining)
  commit()
  for (const _cmd of matched) {
    logOperation('dequeue')
  }
  emitConsumption('dequeued', matched)
  return matched
}

/** Remove by QUEUE-OBTAINED reference identity (see the header law). A
 *  no-hit remove neither notifies nor rerolls the snapshot; journal rows
 *  are written per REQUESTED removal (current truth, pinned). The parked
 *  banks are swept by the same identity (the re-key's drain corner: a
 *  reference the turn machine consumed must never resurrect from a bank,
 *  whatever the swap interleaving was). */
export function remove(commandsToRemove: QueuedCommand[]): void {
  if (commandsToRemove.length === 0) {
    return
  }
  const before = queue.length
  const removed: QueuedCommand[] = []
  for (let i = queue.length - 1; i >= 0; i--) {
    if (commandsToRemove.includes(queue[i]!)) {
      removed.unshift(queue.splice(i, 1)[0]!)
    }
  }
  for (const [key, bank] of parkedQueues) {
    for (let i = bank.length - 1; i >= 0; i--) {
      if (commandsToRemove.includes(bank[i]!)) {
        removed.unshift(bank.splice(i, 1)[0]!)
      }
    }
    if (bank.length === 0) parkedQueues.delete(key)
  }
  if (queue.length !== before) {
    commit()
  }
  for (const _cmd of commandsToRemove) {
    logOperation('remove')
  }
  emitConsumption('removed', removed)
}

// (replaceNext retired with the attention re-route — steer-removal
// follow-up: under instant delivery no queued entry exists to replace;
// the last consumer now rides the delivery door.)

/** Test cleanup: clear WITHOUT notifying (current truth, pinned by the
 *  frozen-snapshot laws). The re-key state resets with it. */
export function resetCommandQueue(): void {
  queue.length = 0
  snapshot = Object.freeze([])
  drainingNow = new Set()
  owningSessionId = null
  parkedQueues.clear()
}

// ── classification ───────────────────────────────────────────────────────────

/** A slash command routes through processSlashCommand, never to the model
 *  as text. `skipSlashCommands` (bridge/CCR messages) opts out — that text
 *  IS meant for the model. */
export function isSlashCommand(cmd: QueuedCommand): boolean {
  return (
    typeof cmd.value === 'string' &&
    cmd.value.trim().startsWith('/') &&
    !cmd.skipSlashCommands
  )
}

// (The pop-to-composer family and the editability/visibility classifiers
// died with the operator-facing pen — the steer-removal ruling: a sent
// message is never held, so there is nothing to pull back or preview.)
