import type { QueuedCommand } from '../../../screen/composer/input-core/textInput.js'
import type { TurnDriverPorts } from '../turnDriver.js'

export const isTaskNotification = (command: QueuedCommand | undefined): command is QueuedCommand =>
  command !== undefined && command.mode === 'task-notification'

export function canBatchWith(
  head: QueuedCommand,
  next: QueuedCommand | undefined,
): boolean {
  return (
    next !== undefined &&
    next.mode === 'prompt' &&
    head.localCommand !== true &&
    next.localCommand !== true &&
    next.workload === head.workload &&
    next.isMeta === head.isMeta &&
    next.schema === undefined &&
    head.schema === undefined
  )
}

export function driverQueue(ports: TurnDriverPorts) {
  const settledAt = new Map<string, number>()
  const now = (): number => ports.clock.now?.() ?? Date.now()
  const queuedMainThread = (): readonly QueuedCommand[] => {
    if (ports.queuedMainThread !== undefined) return ports.queuedMainThread()
    const head = ports.peek()
    return head === undefined ? [] : [head]
  }

  const takeQueued = (): QueuedCommand | undefined => {
    const taken = ports.dequeue()
    if (taken?.queueId !== undefined) settledAt.delete(taken.queueId)
    return taken
  }

  const yieldedOnce = new Set<string>()
  const isOperatorWords = (command: QueuedCommand): boolean =>
    (command.mode === 'prompt' || command.mode === 'bash') && command.isMeta !== true
  const bandOf = (command: QueuedCommand): string => command.priority ?? 'next'

  const wordsBefore = (head: QueuedCommand): QueuedCommand | undefined => {
    if (!isTaskNotification(head)) return undefined
    const queued = queuedMainThread()
    for (const id of yieldedOnce) {
      if (!queued.some(c => c.queueId === id)) yieldedOnce.delete(id)
    }
    if (head.queueId !== undefined && yieldedOnce.has(head.queueId)) return undefined
    const words = queued.find(c => isOperatorWords(c) && bandOf(c) === bandOf(head))
    if (words === undefined) return undefined
    const taken = ports.dequeueCommand(words)
    if (taken === undefined) return undefined
    for (const c of queued) {
      if (isTaskNotification(c) && c.queueId !== undefined) yieldedOnce.add(c.queueId)
    }
    if (taken.queueId !== undefined) settledAt.delete(taken.queueId)
    return taken
  }

  const batchableAfter = (head: QueuedCommand): QueuedCommand | undefined => {
    const next = ports.peek()
    if (!isTaskNotification(next) || bandOf(next) !== bandOf(head)) {
      return canBatchWith(head, next) ? ports.dequeue() : undefined
    }
    const band = queuedMainThread().filter(c => bandOf(c) === bandOf(head))
    const line = band.find(c => !isTaskNotification(c))
    if (line === undefined || !canBatchWith(head, line)) return undefined
    const taken = ports.dequeueCommand(line)
    if (taken === undefined) return undefined
    for (const c of band) {
      if (c === line) break
      if (isTaskNotification(c) && c.queueId !== undefined) yieldedOnce.add(c.queueId)
    }
    return taken
  }

  const runnableHead = (): QueuedCommand | undefined => {
    const head = ports.peek()
    if (head?.origin?.kind !== 'outside-report') return head
    const candidates = queuedMainThread().filter(command => command.origin?.kind !== 'outside-report')
    return candidates.find(command => bandOf(command) === 'now') ?? candidates.find(command => bandOf(command) === 'next') ?? candidates[0]
  }

  const settleQueued = (): void => {
    for (const command of queuedMainThread()) {
      if (isTaskNotification(command) && command.queueId !== undefined) settledAt.set(command.queueId, -Infinity)
    }
  }

  const flushSdkEvents = (): void => {
    for (const row of ports.drainRows()) {
      ports.enqueueOutput(row)
    }
  }
  return { settledAt, now, queuedMainThread, takeQueued, isOperatorWords, wordsBefore, batchableAfter, runnableHead, settleQueued, flushSdkEvents }
}
