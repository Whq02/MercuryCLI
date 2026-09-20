import type { ContentBlockParam } from '../../types/wire.js'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import type { StdoutMessage } from '../../entrypoints/sdk/controlTypes.js'

export type PromptValue = string | ContentBlockParam[]

const AGENT_WAIT_TICK_MS = 100

function toBlocks(v: PromptValue): ContentBlockParam[] {
  return typeof v === 'string' ? [{ type: 'text', text: v }] : v
}

export function foldNotificationValues(values: PromptValue[]): ContentBlockParam[] {
  return values.flatMap(toBlocks)
}

const isTaskNotification = (command: QueuedCommand | undefined): command is QueuedCommand =>
  command !== undefined && command.mode === 'task-notification'

export function joinPromptValues(values: PromptValue[]): PromptValue {
  if (values.length === 1) return values[0]!
  if (values.every(v => typeof v === 'string')) {
    return values.join('\n')
  }
  return values.flatMap(toBlocks)
}

export function canBatchWith(
  head: QueuedCommand,
  next: QueuedCommand | undefined,
): boolean {
  return (
    next !== undefined &&
    next.mode === 'prompt' &&
    next.workload === head.workload &&
    next.isMeta === head.isMeta
  )
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

  enqueueOutput(message: StdoutMessage): void
  writeDirect(message: StdoutMessage): Promise<void>
  drainSdkEvents(): StdoutMessage[]

  executeTurn(
    command: QueuedCommand,
    batchUuids: string[],
    onMessage: (message: StdoutMessage) => void,
  ): Promise<void>
  beforeCycle(): Promise<void>
  onTurnStart(command: QueuedCommand, batch: QueuedCommand[]): StdoutMessage | undefined
  onTurnSettled(command: QueuedCommand): void

  hasWaitableBackgroundTasks(): boolean
  hasHoldableBackgroundAgents(): boolean
  waitableBackgroundTaskCount?(): number
  onAgentWait?(count: number): void

  takePendingSuggestion(): StdoutMessage | null

  settleIdle(): Promise<'reenter' | 'close' | 'stay'>
  closeOutput(): Promise<void>

  notifySessionState(state: 'running' | 'idle'): void
  isShuttingDown(): boolean
  idleTimerStop(): void
  idleTimerStart(): void
  onCycleError(error: unknown): StdoutMessage
  shutdown(code: number): void
  clock: { sleep(ms: number): Promise<void>; now?(): number }
  queuedMainThread?(): readonly QueuedCommand[]
  settleWindowMs?: number
}

export type TurnDriver = {
  kick(): void
  phase(): DriverPhase
  isRunning(): boolean
  hasHeldResult(): boolean
  releaseHold(): void
  closeOutputOnce(): Promise<void>
}

export function createTurnDriver(ports: TurnDriverPorts): TurnDriver {
  let phase: DriverPhase = 'idle'
  let heldBackResult: StdoutMessage | null = null
  let outputClosed = false
  let holdReleased = false

  const settledAt = new Map<string, number>()
  let holding = false
  const now = (): number => ports.clock.now?.() ?? Date.now()
  const queuedMainThread = (): readonly QueuedCommand[] => ports.queuedMainThread?.() ?? []

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

  const nextDue = (): QueuedCommand | undefined => {
    holding = false
    const head = ports.peek()
    if (head === undefined) return undefined
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
    return takeQueued()
  }

  const settleQueued = (): void => {
    for (const command of queuedMainThread()) {
      if (isTaskNotification(command) && command.queueId !== undefined) settledAt.set(command.queueId, -Infinity)
    }
  }

  const flushSdkEvents = (): void => {
    for (const event of ports.drainSdkEvents()) {
      ports.enqueueOutput(event)
    }
  }

  const closeOutputOnce = async (): Promise<void> => {
    if (outputClosed) return
    outputClosed = true
    await ports.closeOutput()
  }

  async function runOneTurn(first: QueuedCommand): Promise<void> {
    let command = first

    const batch: QueuedCommand[] = [command]
    if (command.mode === 'prompt') {
      for (let next = batchableAfter(command); next !== undefined; next = batchableAfter(command)) {
        batch.push(next)
      }
      if (batch.length > 1) {
        command = {
          ...command,
          value: joinPromptValues(batch.map(c => c.value as PromptValue)),
          uuid: batch.findLast((c: QueuedCommand) => c.uuid)?.uuid ?? command.uuid,
        }
      }
    } else if (command.mode === 'task-notification') {
      while (isTaskNotification(ports.peek())) {
        batch.push(takeQueued()!)
      }
      if (batch.length > 1) {
        command = {
          ...command,
          value: foldNotificationValues(batch.map(c => c.value as PromptValue)),
          uuid: batch.findLast((c: QueuedCommand) => c.uuid)?.uuid ?? command.uuid,
        }
      }
    }
    const batchUuids = batch
      .map(c => c.uuid)
      .filter((u): u is NonNullable<typeof u> => u !== undefined)

    let openEdge: StdoutMessage | null = ports.onTurnStart(command, batch) ?? null
    const writeOpenEdge = (): void => {
      if (openEdge === null) return
      ports.enqueueOutput(openEdge)
      openEdge = null
    }

    for (const uuid of batchUuids) {
      ports.notifyLifecycle(uuid, 'started')
    }

    await ports.executeTurn(command, batch.length > 1 ? batchUuids : [], message => {
      if (message.type === 'result') {
        flushSdkEvents()
        writeOpenEdge()
        if (!holdReleased && ports.hasHoldableBackgroundAgents()) {
          heldBackResult = message
        } else {
          heldBackResult = null
          ports.enqueueOutput(message)
        }
      } else {
        flushSdkEvents()
        ports.enqueueOutput(message)
        if (message.type === 'system' && (message as { subtype?: unknown }).subtype === 'init') writeOpenEdge()
      }
    })

    for (const uuid of batchUuids) {
      ports.notifyLifecycle(uuid, 'completed')
    }

    ports.onTurnSettled(command)
  }

  async function cycle(): Promise<void> {
    phase = 'starting'
    holdReleased = false
    ports.notifySessionState('running')
    ports.idleTimerStop()

    await ports.beforeCycle()

    let announcedWait = 0
    const announceWait = (count: number): void => {
      if (count === announcedWait) return
      announcedWait = count
      ports.onAgentWait?.(count)
    }

    try {
      let waitingForAgents = false
      do {
        flushSdkEvents()

        phase = 'draining_commands'
        let command: QueuedCommand | undefined
        while ((command = nextDue())) {
          announceWait(0)
          if (
            command.mode !== 'prompt' &&
            command.mode !== 'bash' &&
            command.mode !== 'orphaned-permission' &&
            command.mode !== 'task-notification'
          ) {
            throw new Error(
              'only prompt commands are supported in streaming mode',
            )
          }
          await runOneTurn(command)
          settleQueued()
        }

        waitingForAgents = false
        if ((!holdReleased && ports.hasWaitableBackgroundTasks()) || ports.peek() !== undefined) {
          waitingForAgents = true
          if (ports.peek() === undefined || holding) {
            phase = 'waiting_for_agents'
            const running = ports.waitableBackgroundTaskCount?.() ?? (ports.hasWaitableBackgroundTasks() ? 1 : 0)
            announceWait(holding ? running : Math.max(1, running))
            await ports.clock.sleep(AGENT_WAIT_TICK_MS)
          }
        }
      } while (waitingForAgents)
      announceWait(0)

      if (heldBackResult) {
        ports.enqueueOutput(heldBackResult)
        heldBackResult = null
        const deferred = ports.takePendingSuggestion()
        if (deferred) {
          ports.enqueueOutput(deferred)
        }
      }
    } catch (error) {
      try {
        await ports.writeDirect(ports.onCycleError(error))
      } catch {
      }
      ports.shutdown(1)
      return
    } finally {
      announceWait(0)
      phase = 'finally'
      if (!ports.isShuttingDown()) {
        ports.notifySessionState('idle')
        flushSdkEvents()
      }
      phase = 'idle'
      ports.idleTimerStart()
    }

    if (ports.peek() !== undefined) {
      void kick()
      return
    }

    phase = 'settling_idle'
    const settled = await ports.settleIdle()
    phase = 'idle'
    if (settled === 'reenter') {
      void kick()
      return
    }
    if (settled === 'close') {
      await closeOutputOnce()
      return
    }
    if (ports.peek() !== undefined) {
      void kick()
    }
  }

  function kick(): void {
    if (phase !== 'idle') {
      return
    }
    void cycle()
  }

  return {
    kick,
    phase: () => phase,
    isRunning: () => phase !== 'idle',
    hasHeldResult: () => heldBackResult !== null,
    releaseHold: () => {
      if (phase === 'idle') return
      holdReleased = true
    },
    closeOutputOnce,
  }
}
