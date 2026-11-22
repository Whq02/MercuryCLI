import { getSessionId } from '../bootstrap/state.js'
import type { AppState } from '../state/AppState.js'
import type {
  QueueOperation,
  QueueOperationMessage,
} from '../types/messageQueueTypes.js'
import type {
  QueuedCommand,
  QueuePriority,
} from '../types/textInputTypes.js'
import { extractTextContent } from '../utils/messages/text.js'
import { recordQueueOperation } from '../utils/sessionStorage.js'
import { createSignal } from '../utils/signal.js'
import { consumeNotices, queuedNoticeKeys, recordQueuedNotice, retireNotices } from '../services/notices/unreadLedger.js'
import { passedOver } from '../utils/passedOver.js'
import { MAIN_LANE, parseOwnerKey, type OwnerKey } from '../utils/run/ownerKey.js'
import { parseSlashCommand } from '../utils/slashCommandParsing.js'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'

export type SetAppState = (...args: Unbuilt[]) => Unbuilt


const triedCompact: Unbuilt = unbuilt('src/input-core/command-queue.ts:22')
const queue: (QueuedCommand & { [triedCompact]?: true })[] = unbuilt('src/input-core/command-queue.ts:23')
function mintQueueId(): string {
  return notBuilt('src/input-core/command-queue.ts:28')
}

function commit(): void {
  return notBuilt('src/input-core/command-queue.ts:32')
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
    } catch (error) {
      passedOver(error)
    }
  }
}

function logOperation(operation: QueueOperation, content?: string, identity?: Pick<QueuedCommand, 'uuid' | 'mode' | 'isMeta' | 'sentAt' | 'origin' | 'agentCompletion'>): void {
  return notBuilt('src/input-core/command-queue.ts:63')
}

const PRIORITY_ORDER: Record<QueuePriority, number> = unbuilt('src/input-core/command-queue.ts:80')

function bestIndexByPriority(
  filter?: (cmd: QueuedCommand) => boolean,
): number {
  return notBuilt('src/input-core/command-queue.ts:86')
}


export const subscribeToCommandQueue: Unbuilt = unbuilt('src/input-core/command-queue.ts:104')

export function getCommandQueueSnapshot(): readonly QueuedCommand[] {
  return notBuilt('src/input-core/command-queue.ts:106')
}


export function getCommandQueue(): QueuedCommand[] {
  return notBuilt('src/input-core/command-queue.ts:111')
}

function getCommandsByMaxPriority(
  maxPriority: QueuePriority,
): QueuedCommand[] {
  return notBuilt('src/input-core/command-queue.ts:115')
}

export function getDrainableCommands(sleepBoundary: boolean): QueuedCommand[] {
  const waits = (cmd: QueuedCommand): boolean => cmd.localCommand === true || (wordsWaitForTurnEnd && cmd.waitsForTurnEnd === true)
  if (!sleepBoundary) return getCommandsByMaxPriority('next').filter(cmd => !waits(cmd))
  const nextThreshold = PRIORITY_ORDER['next']
  return queue.filter(cmd => {
    if (waits(cmd)) return false
    if (PRIORITY_ORDER[cmd.priority ?? 'next'] <= nextThreshold) return true
    return cmd.mode === 'task-notification'
  })
}

let wordsWaitForTurnEnd = false

export function holdQueuedWordsForTurnEnd(on: boolean): void {
  wordsWaitForTurnEnd = on
}

export function queuedWordsWaitForTurnEnd(): boolean {
  return wordsWaitForTurnEnd
}

export function queuedOperatorLines(): QueuedCommand[] {
  return queue.filter(cmd => isOperatorLine(cmd) && cmd.agentId === undefined)
}

export function releaseQueuedWordsToTurn(): number {
  let released = 0
  for (let i = 0; i < queue.length; i++) {
    const cmd = queue[i]!
    if (cmd.waitsForTurnEnd !== true) continue
    const { waitsForTurnEnd: _held, ...rest } = cmd
    queue[i] = rest
    released += 1
  }
  if (released > 0) commit()
  return released
}

let drainingNow: ReadonlySet<QueuedCommand> = new Set()

export function markDraining(commands: readonly QueuedCommand[]): void {
  drainingNow = new Set(commands)
}

let owningSessionId: string | null = null
const parkedQueues = new Map<string, QueuedCommand[]>()

function compactArgs(cmd: QueuedCommand): string | undefined {
  return notBuilt('src/input-core/command-queue.ts:171')
}

export function beginQueuedCompact(owner: OwnerKey): { fresh: boolean; instructions?: string; complete: () => void } | undefined {
  const { sessionId, lane } = parseOwnerKey(owner)
  const sameSession = (): boolean => sessionId === (owningSessionId ?? getSessionId())
  if (lane !== MAIN_LANE || !sameSession()) return undefined
  const ids = new Set<string>()
  let instructions: string | undefined
  let fresh = false
  for (const cmd of queue) {
    const args = compactArgs(cmd)
    if (args === undefined || cmd.queueId === undefined) continue
    ids.add(cmd.queueId)
    if (!cmd[triedCompact]) fresh = true
    cmd[triedCompact] = true
    if (args !== '') instructions = args
  }
  return { fresh, instructions, complete: () => {
    if (sameSession()) dequeueAllMatching(cmd => cmd.queueId !== undefined && (ids.has(cmd.queueId) || compactArgs(cmd) === ''))
  } }
}

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
  const stamped: QueuedCommand = {
    ...command,
    priority: command.priority ?? 'next',
    queueId: mintQueueId(),
    ...(wordsWaitForTurnEnd && command.mode === 'prompt' && command.agentId === undefined ? { waitsForTurnEnd: true } : {}),
  }
  queue.push(stamped)
  commit()
  recordQueuedNotice(stamped)
  logOperation(
    'enqueue',
    typeof command.value === 'string' ? command.value : undefined,
    stamped,
  )
}

export function enqueuePendingNotification(command: QueuedCommand): void {
  return notBuilt('src/input-core/command-queue.ts:261')
}

export function dequeue(
  filter?: (cmd: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  return notBuilt('src/input-core/command-queue.ts:278')
}

export function dequeueAll(): QueuedCommand[] {
  if (queue.length === 0) {
    return []
  }
  const commands = [...queue]
  queue.length = 0
  commit()
  for (const cmd of commands) {
    logOperation('dequeue', undefined, cmd)
  }
  rememberTaken(commands)
  consumeNotices(queuedNoticeKeys(commands))
  emitConsumption('dequeued', commands)
  return commands
}

export function dequeueAllMatching(
  predicate: (cmd: QueuedCommand) => boolean,
): QueuedCommand[] {
  return notBuilt('src/input-core/command-queue.ts:308')
}

export function remove(commandsToRemove: QueuedCommand[]): void {
  return notBuilt('src/input-core/command-queue.ts:335')
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
  logOperation('pop', typeof cmd.value === 'string' ? cmd.value : undefined, cmd)
  retireNotices(queuedNoticeKeys([cmd]), 'taken back before a turn read it')
  emitConsumption('popped', [cmd])
  return { popped: true, command: cmd, text: textOfCommand(cmd) }
}

export function resetCommandQueue(): void {
  return notBuilt('src/input-core/command-queue.ts:400')
}


export function isSlashCommand(cmd: QueuedCommand): boolean {
  return notBuilt('src/input-core/command-queue.ts:411')
}

export const RESTART_CARRY_ROW_PREFIX = 'runner restarted '
const RESTART_CARRY_TEXT = /^\s*(?:<system-reminder>\s*)?runner restarted /

export function isRestartCarryText(text: string): boolean {
  return RESTART_CARRY_TEXT.test(text)
}

const HELD_NOTICE_STATUS = /<status>\s*(?:completed|failed|killed|stopped)\s*<\/status>/
const ENDED_WATCH_NOTICE = /^<monitor\b[^\n]*>\n\[Monitor (?:"|stopped)/

export function isHeldNotice(cmd: QueuedCommand): boolean {
  if (cmd.mode !== 'task-notification') return false
  const text = textOfCommand(cmd)
  return HELD_NOTICE_STATUS.test(text) || ENDED_WATCH_NOTICE.test(text) || isRestartCarryText(text)
}

export function isOperatorLine(cmd: QueuedCommand): boolean {
  return (cmd.mode === 'prompt' || cmd.mode === 'bash') && cmd.isMeta !== true
}

const HOST_NOTICE_ID = /<task-id>host-[0-9a-f]{64}<\/task-id>/

export function isHostNotice(cmd: QueuedCommand): boolean {
  return cmd.mode === 'task-notification' && HOST_NOTICE_ID.test(textOfCommand(cmd))
}

