import type { ContentBlockParam } from '../../types/wire.js'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import type { StdoutMessage } from '../../entrypoints/sdk/controlTypes.js'

export type PromptValue = string | ContentBlockParam[]

function toBlocks(v: PromptValue): ContentBlockParam[] {
  return typeof v === 'string' ? [{ type: 'text', text: v }] : v
}

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
  clock: { sleep(ms: number): Promise<void> }
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
      while (canBatchWith(command, ports.peek())) {
        batch.push(ports.dequeue()!)
      }
      if (batch.length > 1) {
        command = {
          ...command,
          value: joinPromptValues(batch.map(c => c.value as PromptValue)),
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
        while ((command = ports.dequeue())) {
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
        }

        waitingForAgents = false
        if ((!holdReleased && ports.hasWaitableBackgroundTasks()) || ports.peek() !== undefined) {
          waitingForAgents = true
          if (ports.peek() === undefined) {
            phase = 'waiting_for_agents'
            announceWait(Math.max(1, ports.waitableBackgroundTaskCount?.() ?? 1))
            await ports.clock.sleep(100)
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
