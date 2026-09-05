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
import { extractTextContent } from '../utils/messages/text.js'
import { objectGroupBy } from '../utils/objectGroupBy.js'
import { recordQueueOperation } from '../utils/sessionStorage.js'
import { createSignal } from '../utils/signal.js'

export type SetAppState = (f: (prev: AppState) => AppState) => void


const queue: QueuedCommand[] = []
let snapshot: readonly QueuedCommand[] = Object.freeze([])
const queueChanged = createSignal()

let queueIdSeq = 0
function mintQueueId(): string {
  return `q${++queueIdSeq}`
}

function commit(): void {
  snapshot = Object.freeze([...queue])
  queueChanged.emit()
}


export type QueueConsumptionEvent = {
  kind: 'dequeued' | 'removed' | 'cleared' | 'popped'
  commands: readonly QueuedCommand[]
}

type QueueConsumptionListener = (event: QueueConsumptionEvent) => void
const consumptionListeners = new Set<QueueConsumptionListener>()

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
    }
  }
}

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


export const subscribeToCommandQueue = queueChanged.subscribe

export function getCommandQueueSnapshot(): readonly QueuedCommand[] {
  return snapshot
}


export function getCommandQueue(): QueuedCommand[] {
  return [...queue]
}

function getCommandsByMaxPriority(
  maxPriority: QueuePriority,
): QueuedCommand[] {
  const threshold = PRIORITY_ORDER[maxPriority]
  return queue.filter(
    cmd => PRIORITY_ORDER[cmd.priority ?? 'next'] <= threshold,
  )
}

export function getDrainableCommands(sleepBoundary: boolean): QueuedCommand[] {
  if (!sleepBoundary) return getCommandsByMaxPriority('next')
  const nextThreshold = PRIORITY_ORDER['next']
  return queue.filter(cmd => {
    if (PRIORITY_ORDER[cmd.priority ?? 'next'] <= nextThreshold) return true
    return cmd.mode === 'task-notification'
  })
}

let drainingNow: ReadonlySet<QueuedCommand> = new Set()

export function markDraining(commands: readonly QueuedCommand[]): void {
  drainingNow = new Set(commands)
}

let owningSessionId: string | null = null
const parkedQueues = new Map<string, QueuedCommand[]>()

export function rekeyCommandQueueToSession(sessionId: string | null, opts?: { landing?: boolean }): void {
  const prevKey = owningSessionId ?? getSessionId()
  const nextKey = sessionId ?? getSessionId()
  owningSessionId = sessionId
  if (nextKey === prevKey) return
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

export function peek(
  filter?: (cmd: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  const idx = bestIndexByPriority(filter)
  return idx === -1 ? undefined : queue[idx]
}


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

export function dequeue(
  filter?: (cmd: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  const idx = bestIndexByPriority(filter)
  if (idx === -1) return undefined
  const [dequeued] = queue.splice(idx, 1)
  commit()
  logOperation('dequeue')
  rememberTaken(dequeued ? [dequeued] : [])
  emitConsumption('dequeued', dequeued ? [dequeued] : [])
  return dequeued
}

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
  rememberTaken(commands)
  emitConsumption('dequeued', commands)
  return commands
}

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
  rememberTaken(matched)
  emitConsumption('dequeued', matched)
  return matched
}

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
  rememberTaken(removed)
  emitConsumption('removed', removed)
}


const TAKEN_MEMORY = 256
const takenUuids: string[] = []
function rememberTaken(commands: readonly QueuedCommand[]): void {
  for (const cmd of commands) {
    if (cmd.uuid === undefined) continue
    takenUuids.push(String(cmd.uuid))
  }
  if (takenUuids.length > TAKEN_MEMORY) takenUuids.splice(0, takenUuids.length - TAKEN_MEMORY)
}

export type PopReceipt =
  | { popped: true; command: QueuedCommand; text: string }
  | { popped: false; reason: 'taken' | 'unknown' }

function textOfCommand(cmd: QueuedCommand): string {
  if (typeof cmd.value === 'string') return cmd.value
  return Array.isArray(cmd.value) ? extractTextContent(cmd.value, '\n') : ''
}

export function popById(uuid: string): PopReceipt {
  if (uuid === '') return { popped: false, reason: 'unknown' }
  const idx = queue.findIndex(cmd => cmd.uuid !== undefined && String(cmd.uuid) === uuid)
  if (idx === -1) return { popped: false, reason: takenUuids.includes(uuid) ? 'taken' : 'unknown' }
  const cmd = queue[idx]!
  if (drainingNow.has(cmd)) return { popped: false, reason: 'taken' }
  queue.splice(idx, 1)
  commit()
  logOperation('pop', typeof cmd.value === 'string' ? cmd.value : undefined)
  emitConsumption('popped', [cmd])
  return { popped: true, command: cmd, text: textOfCommand(cmd) }
}

export function resetCommandQueue(): void {
  queue.length = 0
  snapshot = Object.freeze([])
  drainingNow = new Set()
  owningSessionId = null
  parkedQueues.clear()
  takenUuids.length = 0
}


export function isSlashCommand(cmd: QueuedCommand): boolean {
  return (
    typeof cmd.value === 'string' &&
    cmd.value.trim().startsWith('/') &&
    !cmd.skipSlashCommands
  )
}
