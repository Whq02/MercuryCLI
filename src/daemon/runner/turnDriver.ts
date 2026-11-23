import { AsyncLocalStorage } from 'node:async_hooks'
import type { ContentBlockParam } from '../../engine/message-shapes/wire.js'
import type { QueuedCommand } from '../../screen/composer/input-core/textInput.js'
import { turnOpened, isOutcome, type LooseRow } from '../../engine/rows/read.js'
import type { RowDraft } from '../../engine/rows/project.js'
import { wallRecheckDelayMs, type WatchWall } from '../../tools/monitor/watchMailbox.js'
import { joinBatchedContent } from '../../engine/message-shapes/batchedContent.js'
import { driverQueue, isTaskNotification } from './turn-driver/queue.js'
import { passedOver } from '../../platform/errors/passedOver.js'
export { canBatchWith } from './turn-driver/queue.js'

export type PromptValue = string | ContentBlockParam[]

const AGENT_WAIT_TICK_MS = 100

function toBlocks(v: PromptValue): ContentBlockParam[] {
  return typeof v === 'string' ? [{ type: 'text', text: v }] : v
}

export function foldNotificationValues(values: PromptValue[]): ContentBlockParam[] {
  return values.flatMap(toBlocks)
}

export function spokenNotifications(batch: readonly QueuedCommand[]): QueuedCommand[] {
  const shown = batch.filter(member => member.isMeta !== true)
  return shown.length > 0 ? shown : [...batch]
}

export function foldNotifications(batch: readonly QueuedCommand[]): QueuedCommand {
  const spoken = spokenNotifications(batch)
  const head = spoken[0]!
  return {
    ...head,
    value: spoken.length > 1 ? foldNotificationValues(spoken.map(member => member.value as PromptValue)) : head.value,
    uuid: batch.findLast(member => member.uuid !== undefined)?.uuid ?? head.uuid,
  }
}

export function joinPromptValues(values: PromptValue[]): PromptValue {
  return joinBatchedContent(values)
}

export type DriverPhase =
  | 'idle'
  | 'starting'
  | 'draining_commands'
  | 'waiting_for_agents'
  | 'finally'
  | 'settling_idle'

export type TurnDriverPorts = {
  dequeue(): QueuedCommand | undefined
  dequeueCommand(command: QueuedCommand): QueuedCommand | undefined
  peek(): QueuedCommand | undefined
  notifyLifecycle(uuid: string, event: 'started' | 'completed'): void

  enqueueOutput(message: RowDraft): void
  writeDirect(message: RowDraft): Promise<void>
  drainRows(): RowDraft[]

  executeTurn(
    command: QueuedCommand,
    batch: QueuedCommand[],
    onMessage: (message: RowDraft) => void,
    initialNotices?: QueuedCommand[],
  ): Promise<void>
  beforeCycle(): Promise<void>
  onTurnStart(command: QueuedCommand, batch: QueuedCommand[]): void
  turnIdOf(): string
  openTurnRow(messageIds: string[]): RowDraft
  onTurnSettled(command: QueuedCommand): void

  hasWaitableBackgroundTasks(): boolean
  hasHoldableBackgroundAgents(): boolean
  waitableBackgroundTaskCount?(): number
  onAgentWait?(count: number, turnId: string): void

  settleIdle(): Promise<'reenter' | 'close' | 'stay'>
  wakeSettle?(): void
  closeOutput(): Promise<void>
  beforeCloseOutput?(): Promise<void>

  isShuttingDown(): boolean
  idleTimerStop(): void
  idleTimerStart(): void
  onCycleError(error: unknown, turnId: string): RowDraft
  shutdown(code: number): void
  clock: { sleep(ms: number): Promise<void>; now?(): number }
  queuedMainThread?(): readonly QueuedCommand[]
  settleWindowMs?: number
  wall?(): WatchWall
}

export type TurnDriver = {
  kick(): void
  phase(): DriverPhase
  isRunning(): boolean
  onIdle(listener: () => void): () => void
  hasHeldResult(): boolean
  releaseHold(): void
  endOperatorWait(): void
  closeOutputOnce(): Promise<void>
  hasDueQueued(): boolean
}

interface TurnDriverState {
  heldBackResult: RowDraft | null
  anyTurnCompleted: boolean
  holdReleased: boolean
  noticesAwaitOperator: boolean
}

type DriverQueue = ReturnType<typeof driverQueue>

async function runDriverTurn(
  first: QueuedCommand,
  ports: TurnDriverPorts,
  queue: DriverQueue,
  state: TurnDriverState,
): Promise<void> {
  let command = first
  const initialNotices: QueuedCommand[] = []
  if (queue.isOperatorWords(first)) {
    const held = state.noticesAwaitOperator
    state.noticesAwaitOperator = false
    for (const notice of queue.queuedMainThread().filter(isTaskNotification)) {
      if (!held && notice.ridesNextWords !== true) continue
      const taken = ports.dequeueCommand(notice)
      if (taken === undefined) continue
      if (taken.queueId !== undefined) queue.settledAt.delete(taken.queueId)
      initialNotices.push(taken)
    }
  }

  const batch: QueuedCommand[] = [command]
  if (command.mode === 'prompt') {
    for (let next = queue.batchableAfter(command); next !== undefined; next = queue.batchableAfter(command)) {
      batch.push(next)
    }
  } else if (command.mode === 'task-notification') {
    while (isTaskNotification(ports.peek()) && ports.peek()?.origin?.kind !== 'outside-report') {
      batch.push(queue.takeQueued()!)
    }
    if (batch.length > 1) command = foldNotifications(batch)
  }
  const batchUuids = [...initialNotices, ...batch]
    .map(c => c.uuid)
    .filter((u): u is NonNullable<typeof u> => u !== undefined)

  ports.onTurnStart(command, batch)
  let turnOpen = false
  const openIfUnopened = (): void => {
    if (turnOpen) return
    turnOpen = true
    ports.enqueueOutput(ports.openTurnRow(batchUuids))
  }

  for (const uuid of batchUuids) {
    ports.notifyLifecycle(uuid, 'started')
  }

  let answered = false
  const deliver = (message: RowDraft): void => {
    const row = message as LooseRow
    if (turnOpened(row)) turnOpen = true
    if (isOutcome(row)) {
      if (row.status === 'completed') state.anyTurnCompleted = true
      answered = true
      queue.flushSdkEvents()
      openIfUnopened()
      if (!state.holdReleased && ports.hasHoldableBackgroundAgents()) {
        state.heldBackResult = message
      } else {
        state.heldBackResult = null
        ports.enqueueOutput(message)
      }
    } else {
      queue.flushSdkEvents()
      ports.enqueueOutput(message)
    }
  }

  await ports.executeTurn(command, batch.length > 1 ? batch : [], message => {
    deliver(message)
  }, initialNotices).catch((error: unknown) => {
    if (answered) throw error
    deliver(ports.onCycleError(error, ports.turnIdOf()))
  })

  for (const uuid of batchUuids) {
    ports.notifyLifecycle(uuid, 'completed')
  }

  ports.onTurnSettled(command)
}

export function createTurnDriver(ports: TurnDriverPorts): TurnDriver {
  const seatContext = AsyncLocalStorage.snapshot()
  let phase: DriverPhase = 'idle'
  const state: TurnDriverState = {
    heldBackResult: null,
    anyTurnCompleted: false,
    holdReleased: false,
    noticesAwaitOperator: false,
  }
  let outputClosed = false
  let wakeAgentWait: (() => void) | undefined
  const idleListeners = new Set<() => void>()
  const notifyIdle = (): void => {
    if (phase !== 'idle') return
    for (const listener of [...idleListeners]) listener()
  }

  const queue = driverQueue(ports)
  const { settledAt, now, queuedMainThread, takeQueued, isOperatorWords, wordsBefore, runnableHead, settleQueued, flushSdkEvents } = queue
  let holding = false
  let wallHeld = false
  let wall: (WatchWall & { recheckAtMs: number }) | null = null
  let wallTimerArmed = false
  const wallClosed = (): boolean => {
    if (ports.wall === undefined) return false
    const t = now()
    if (wall === null || !wall.closed || t >= wall.recheckAtMs) {
      const read = ports.wall()
      wall = { ...read, recheckAtMs: t + wallRecheckDelayMs(read, t) }
    }
    return wall.closed
  }

  const dueQueued = (): boolean => {
    const head = runnableHead()
    if (head === undefined) return false
    if (state.noticesAwaitOperator) return queuedMainThread().some(isOperatorWords)
    if (!isTaskNotification(head)) return true
    if (queuedMainThread().some(c => !isTaskNotification(c))) return true
    return !(wall !== null && wall.closed && now() < wall.recheckAtMs)
  }

  const armWallRecheck = (): void => {
    if (wallTimerArmed || wall === null || !wall.closed) return
    wallTimerArmed = true
    void ports.clock.sleep(Math.max(0, wall.recheckAtMs - now())).then(() => {
      wallTimerArmed = false
      kick()
    })
  }

  const nextDue = (): QueuedCommand | undefined => {
    holding = false
    wallHeld = false
    const head = runnableHead()
    if (head === undefined || state.holdReleased) return undefined
    if (state.noticesAwaitOperator) {
      const words = queuedMainThread().find(isOperatorWords)
      return words === undefined ? undefined : ports.dequeueCommand(words)
    }
    const words = wordsBefore(head)
    if (words !== undefined) return words
    const window = ports.settleWindowMs ?? 0
    if (isTaskNotification(head) && head.queueId !== undefined && window > 0) {
      const queued = queuedMainThread()
      for (const id of settledAt.keys()) {
        if (!queued.some(c => c.queueId === id)) settledAt.delete(id)
      }
      if (queued.every(isTaskNotification)) {
        const seen = settledAt.get(head.queueId)
        if (seen === undefined) settledAt.set(head.queueId, now())
        if (seen === undefined || now() - seen < window) {
          holding = true
          return undefined
        }
      }
    }
    if (isTaskNotification(head) && wallClosed()) {
      const line = queuedMainThread().find(c => !isTaskNotification(c))
      const taken = line === undefined ? undefined : ports.dequeueCommand(line)
      if (taken !== undefined) {
        if (taken.queueId !== undefined) settledAt.delete(taken.queueId)
        return taken
      }
      wallHeld = true
      return undefined
    }
    if (head === ports.peek()) return takeQueued()
    const taken = ports.dequeueCommand(head)
    if (taken?.queueId !== undefined) settledAt.delete(taken.queueId)
    return taken
  }

  const closeOutputOnce = async (): Promise<void> => {
    if (outputClosed) return
    outputClosed = true
    if (state.anyTurnCompleted && !ports.isShuttingDown()) await ports.beforeCloseOutput?.()
    await ports.closeOutput()
  }

  async function cycle(): Promise<void> {
    phase = 'starting'
    state.holdReleased = false
    ports.idleTimerStop()

    await ports.beforeCycle()

    let announcedWait = 0
    const announceWait = (count: number): void => {
      if (count === announcedWait) return
      announcedWait = count
      ports.onAgentWait?.(count, ports.turnIdOf())
    }

    let failed = false
    try {
      let waitingForAgents = false
      do {
        flushSdkEvents()

        phase = 'draining_commands'
        let command: QueuedCommand | undefined
        let ranCommand = false
        while ((command = nextDue())) {
          ranCommand = true
          announceWait(0)
          if (
            command.mode !== 'prompt' &&
            command.mode !== 'bash' &&
            command.mode !== 'task-notification'
          ) {
            throw new Error(
              'only prompt commands are supported in streaming mode',
            )
          }
          await runDriverTurn(command, ports, queue, state)
          settleQueued()
        }

        waitingForAgents = false
        if (!state.holdReleased && (ports.hasWaitableBackgroundTasks() || dueQueued())) {
          waitingForAgents = true
          if (!ranCommand || holding || wallHeld) {
            phase = 'waiting_for_agents'
            const running = ports.waitableBackgroundTaskCount?.() ?? (ports.hasWaitableBackgroundTasks() ? 1 : 0)
            announceWait(holding ? running : Math.max(1, running))
            await new Promise<void>(resolve => {
              wakeAgentWait = resolve
              void ports.clock.sleep(AGENT_WAIT_TICK_MS).then(resolve)
            })
            wakeAgentWait = undefined
          }
        }
      } while (waitingForAgents)
      announceWait(0)

      if (state.heldBackResult) {
        ports.enqueueOutput(state.heldBackResult)
        state.heldBackResult = null
      }
    } catch (error) {
      failed = true
      try {
        await ports.writeDirect(ports.onCycleError(error, ports.turnIdOf()))
      } catch (error) { passedOver(error) }
      ports.shutdown(1)
      return
    } finally {
      announceWait(0)
      phase = 'finally'
      if (!ports.isShuttingDown()) {
        flushSdkEvents()
      }
      phase = 'idle'
      ports.idleTimerStart()
      if (failed) notifyIdle()
    }

    if (dueQueued()) {
      void kick()
      notifyIdle()
      return
    }
    if (wallHeld) armWallRecheck()

    phase = 'settling_idle'
    const settled = await ports.settleIdle()
    phase = 'idle'
    if (settled === 'reenter') {
      void kick()
      notifyIdle()
      return
    }
    if (settled === 'close') {
      notifyIdle()
      await closeOutputOnce()
      return
    }
    if (dueQueued()) {
      void kick()
    }
    notifyIdle()
  }

  function kick(): void {
    if (phase === 'settling_idle') {
      ports.wakeSettle?.()
      return
    }
    if (phase !== 'idle' || (state.noticesAwaitOperator && !dueQueued())) {
      return
    }
    seatContext(() => {
      void cycle()
    })
  }

  return {
    kick,
    phase: () => phase,
    isRunning: () => phase !== 'idle',
    onIdle: listener => {
      idleListeners.add(listener)
      return () => {
        idleListeners.delete(listener)
      }
    },
    hasHeldResult: () => state.heldBackResult !== null,
    releaseHold: () => {
      if (phase === 'idle') return
      state.holdReleased = true
      state.noticesAwaitOperator = true
      wakeAgentWait?.()
    },
    endOperatorWait: () => {
      state.noticesAwaitOperator = false
      kick()
    },
    closeOutputOnce,
    hasDueQueued: dueQueued,
  }
}
