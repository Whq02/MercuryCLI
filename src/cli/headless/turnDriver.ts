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
  | 'finally_flush'
  | 'finally_post_flush'
  | 'settling_idle'

export type TurnDriverPorts = {
  dequeue(): QueuedCommand | undefined
  peek(): QueuedCommand | undefined
  notifyLifecycle(uuid: string, event: 'started' | 'completed'): void

  enqueueOutput(message: StdoutMessage): void
  writeDirect(message: StdoutMessage): Promise<void>
  drainSdkEvents(): StdoutMessage[]
  flushInternalEvents(): Promise<void>

  executeTurn(
    command: QueuedCommand,
    onMessage: (message: StdoutMessage) => void,
  ): Promise<void>
  beforeCycle(): Promise<void>
  onTurnStart(command: QueuedCommand, batch: QueuedCommand[]): void
  onTurnSettled(command: QueuedCommand): void

  hasWaitableBackgroundTasks(): boolean
  hasHoldableBackgroundAgents(): boolean

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
  closeOutputOnce(): Promise<void>
}

export function createTurnDriver(ports: TurnDriverPorts): TurnDriver {
  let phase: DriverPhase = 'idle'
  let heldBackResult: StdoutMessage | null = null
  let outputClosed = false

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

    ports.onTurnStart(command, batch)

    for (const uuid of batchUuids) {
      ports.notifyLifecycle(uuid, 'started')
    }

    await ports.executeTurn(command, message => {
      if (message.type === 'result') {
        flushSdkEvents()
        if (ports.hasHoldableBackgroundAgents()) {
          heldBackResult = message
        } else {
          heldBackResult = null
          ports.enqueueOutput(message)
        }
      } else {
        flushSdkEvents()
        ports.enqueueOutput(message)
      }
    })

    for (const uuid of batchUuids) {
      ports.notifyLifecycle(uuid, 'completed')
    }

    ports.onTurnSettled(command)
  }

  async function cycle(): Promise<void> {
    phase = 'starting'
    ports.notifySessionState('running')
    ports.idleTimerStop()

    await ports.beforeCycle()

    try {
      let waitingForAgents = false
      do {
        flushSdkEvents()

        phase = 'draining_commands'
        let command: QueuedCommand | undefined
        while ((command = ports.dequeue())) {
          if (
            command.mode !== 'prompt' &&
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
        if (ports.hasWaitableBackgroundTasks() || ports.peek() !== undefined) {
          waitingForAgents = true
          if (ports.peek() === undefined) {
            phase = 'waiting_for_agents'
            await ports.clock.sleep(100)
          }
        }
      } while (waitingForAgents)

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
      phase = 'finally_flush'
      await ports.flushInternalEvents()
      phase = 'finally_post_flush'
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
    closeOutputOnce,
  }
}
