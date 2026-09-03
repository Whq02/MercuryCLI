// ============================================================================
//  cli/headless/turnDriver.ts — the headless turn
//  driver.
//
//  The -p / stream-json / SDK run loop's BASE-descended decisions, owned as
//  ONE explicit lifecycle machine (the old body interleaved them through
//  five interacting booleans — running · runPhase · waitingForAgents ·
//  inputClosed · shutdownPromptInjected — plus a heldBackResult slot and
//  TWO duplicated close-output bands):
//
//  • THE KICK MUTEX — kick() no-ops unless idle; the post-cycle queue
//    recheck closes the "message arrived between the last dequeue and
//    going idle" stranding window the old comment documented.
//  • DRAIN + BATCH — consecutive prompt-mode commands with matching
//    workload/isMeta coalesce into one turn (canBatchWith/joinPromptValues
//    — the P-contract helpers live HERE now; print.ts re-exports); merged
//    uuids get replay acks so per-uuid consumers see every message settle.
//  • THE HOLD-BACK RULE — a result envelope is withheld from the stream
//    while holdable background agents run, and released (with any deferred
//    prompt suggestion) only when the wait loop settles.
//  • WAIT-FOR-AGENTS — after a drain the driver re-enters while background
//    tasks run or new main-thread commands queue (100ms tick; in-process
//    teammates are excluded — long-lived by design, waiting on them would
//    hold the result forever).
//  • EXACTLY-ONCE SHUTDOWN — closeOutput() is the one close-output owner;
//    the old body duplicated the suggestion-wait + unsubscribe + done()
//    band at both close sites (run-side and stdin-side).
//  • THE ERROR/FINALLY DISCIPLINE — a thrown cycle writes the
//    error_during_execution envelope DIRECTLY to the io (immediate
//    delivery), then shuts down; every cycle flushes internal events and
//    notifies idle exactly once on the way out.
//
//  Feature blocks that are Mercury-era additions (teammate inbox polling,
//  team shutdown prompting, suggestion generation internals, cron, MCP
//  wiring) stay in print.ts and reach the driver through ports —
//  settleIdle() decides what happens after a drain settles, executeTurn()
//  is the ask() wiring. The driver owns turn lifecycle, not features.
// ============================================================================
import type { ContentBlockParam } from '../../types/wire.js'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import type { StdoutMessage } from '../../entrypoints/sdk/controlTypes.js'

export type PromptValue = string | ContentBlockParam[]

function toBlocks(v: PromptValue): ContentBlockParam[] {
  return typeof v === 'string' ? [{ type: 'text', text: v }] : v
}

/**
 * Fold a batch of queued prompt values into one. All-string batches join on
 * newlines; one block array anywhere promotes EVERY value to blocks, and
 * the block lists concatenate.
 */
export function joinPromptValues(values: PromptValue[]): PromptValue {
  if (values.length === 1) return values[0]!
  if (values.every(v => typeof v === 'string')) {
    return values.join('\n')
  }
  return values.flatMap(toBlocks)
}

/**
 * May `next` join `head`'s turn? Three gates: prompt-mode only; equal
 * workload tags (the merged turn must attribute to ONE workload); equal
 * isMeta flags (the head's flag spreads over the merged command, so letting
 * a proactive tick merge into a real user prompt would strip the tick's
 * hidden-in-transcript marking).
 */
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

/** The driver's lifecycle states — one word per phase the old body spread
 *  across interacting booleans. `phase()` is read by the SIGTERM state dump. */
export type DriverPhase =
  | 'idle'
  | 'starting'
  | 'draining_commands'
  | 'waiting_for_agents'
  | 'finally_flush'
  | 'finally_post_flush'
  | 'settling_idle'

export type TurnDriverPorts = {
  // ── the queue (main-thread scoped — the caller binds the filter) ────────
  dequeue(): QueuedCommand | undefined
  peek(): QueuedCommand | undefined
  notifyLifecycle(uuid: string, event: 'started' | 'completed'): void

  // ── the output stream ────────────────────────────────────────────────────
  enqueueOutput(message: StdoutMessage): void
  /** Direct, immediate write — the error-envelope path only. */
  writeDirect(message: StdoutMessage): Promise<void>
  /** SDK event queue (task_started / task_progress / bookends). */
  drainSdkEvents(): StdoutMessage[]
  flushInternalEvents(): Promise<void>

  // ── the turn itself (print.ts's ask() wiring; per-turn one-shots ride
  //     inside: elicitation registration, workload ALS, profiler marks) ────
  /** Runs one turn for the (possibly batched) command, delivering every
   *  SDK message to the sink AS the turn streams. Callback-shaped (not an
   *  AsyncIterable) deliberately: the consumption must happen INSIDE the
   *  caller's runWithWorkload ALS context so background agents spawned in
   *  ask() inherit the workload across detached awaits — a driver-side
   *  pull would resume the generator in the driver's context instead. */
  executeTurn(
    command: QueuedCommand,
    onMessage: (message: StdoutMessage) => void,
  ): Promise<void>
  /** Pre-cycle async setup (updateSdkMcp). */
  beforeCycle(): Promise<void>
  /** Turn bookkeeping hooks that stay feature-side. */
  onTurnStart(command: QueuedCommand, batch: QueuedCommand[]): void
  onTurnSettled(command: QueuedCommand): void

  // ── the census the wait/hold-back rules read ─────────────────────────────
  /** Background tasks that keep the wait loop alive (in-process teammates
   *  excluded — long-lived by design). */
  hasWaitableBackgroundTasks(): boolean
  /** Background agents/workflows whose completion the result must wait on
   *  (the hold-back rule's narrower census). */
  hasHoldableBackgroundAgents(): boolean
  /** The count behind hasWaitableBackgroundTasks — what the agent wait
   *  speaks (below). Absent ⇒ the wait is announced as one. */
  waitableBackgroundTaskCount?(): number
  /** The agent wait spoken to the host: called with the running count when
   *  the drain parks on background tasks (nothing queued, agents still
   *  running) and again with 0 when that wait ends — the turn's own stream
   *  is over by then, so a seat painting "thinking" over this wait would
   *  lie; the host relays the count as the session's state word. Called
   *  only when the announced count changes. */
  onAgentWait?(count: number): void

  // ── the deferred-suggestion slot (feature-side state, driver-timed) ─────
  takePendingSuggestion(): StdoutMessage | null

  // ── after a drain settles (feature blocks: teammate poll, team
  //     shutdown, input-closed handling). 'reenter' → new work was queued;
  //     'close' → the session is over, close the output exactly once;
  //     'stay' → stay idle and wait for input/kicks. ──────────────────────
  settleIdle(): Promise<'reenter' | 'close' | 'stay'>
  /** The one close-output band (suggestion wait · unsubscribes · done()). */
  closeOutput(): Promise<void>

  // ── lifecycle notifications ──────────────────────────────────────────────
  notifySessionState(state: 'running' | 'idle'): void
  isShuttingDown(): boolean
  idleTimerStop(): void
  idleTimerStart(): void
  onCycleError(error: unknown): StdoutMessage
  shutdown(code: number): void
  clock: { sleep(ms: number): Promise<void> }
}

export type TurnDriver = {
  /** Start a cycle if idle; no-op while one runs (the run() mutex). */
  kick(): void
  phase(): DriverPhase
  isRunning(): boolean
  /** A result envelope is currently held back for background agents —
   *  read by the suggestion generator to defer its emission. */
  hasHeldResult(): boolean
  /** The exactly-once output close — callable from the driver's own settle
   *  path AND the stdin-side input-close path. */
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

  /** One (possibly batched) command through its turn: replay acks for
   *  merged uuids, lifecycle marks, the SDK stream with hold-back. */
  async function runOneTurn(first: QueuedCommand): Promise<void> {
    let command = first

    // Only prompt commands batch — they greedily absorb eligible followers
    // (canBatchWith). The non-prompt kinds (task-notification,
    // orphaned-permission) carry per-command side effects or state and MUST
    // run one at a time.
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

    // Feature-side per-turn setup: replay acks for the merged uuids,
    // elicitation registration, suggestion-state settlement, task-
    // notification SDK event emission — everything the old drain body did
    // between batching and ask().
    ports.onTurnStart(command, batch)

    for (const uuid of batchUuids) {
      ports.notifyLifecycle(uuid, 'started')
    }

    await ports.executeTurn(command, message => {
      if (message.type === 'result') {
        // Pending SDK events must land on the stream BEFORE the result
        // envelope they narrate.
        flushSdkEvents()
        // The hold-back rule: while holdable background agents run, the
        // result waits (released by the post-drain block in cycle()).
        if (ports.hasHoldableBackgroundAgents()) {
          heldBackResult = message
        } else {
          heldBackResult = null
          ports.enqueueOutput(message)
        }
      } else {
        // task_started/task_progress stream live between messages — never
        // batched up until the result.
        flushSdkEvents()
        ports.enqueueOutput(message)
      }
    })

    for (const uuid of batchUuids) {
      ports.notifyLifecycle(uuid, 'completed')
    }

    // Feature-side per-turn teardown: prompt-suggestion generation,
    // profiler turn marks.
    ports.onTurnSettled(command)
  }

  async function cycle(): Promise<void> {
    phase = 'starting'
    ports.notifySessionState('running')
    ports.idleTimerStop()

    await ports.beforeCycle()

    // The announced agent wait (0 = none announced): the host hears every
    // change, and the exit of the cycle always speaks 0.
    let announcedWait = 0
    const announceWait = (count: number): void => {
      if (count === announcedWait) return
      announcedWait = count
      ports.onAgentWait?.(count)
    }

    try {
      // The drain loop: empty the command queue, then stay in the loop while
      // background agents run — their completion notifications enqueue as
      // commands, and the loop drains those too.
      let waitingForAgents = false
      do {
        // SDK events flush ahead of the command queue so progress events
        // land on the stream before the task_notification they precede.
        flushSdkEvents()

        phase = 'draining_commands'
        let command: QueuedCommand | undefined
        while ((command = ports.dequeue())) {
          // A command drains as a turn of its own: the wait it may have
          // interrupted is over (a fresh stream speaks for itself).
          announceWait(0)
          // A bash line is a turn like any other: it runs one at a time
          // (never batched), under the same in-flight fact and abort
          // controller as a model turn — so the seat's busy edge spans the
          // shell and an interrupt frame reaches it. Refusing it here wrote
          // an error result and shut the runner down on every `!` line.
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
        if (ports.hasWaitableBackgroundTasks() || ports.peek() !== undefined) {
          waitingForAgents = true
          if (ports.peek() === undefined) {
            phase = 'waiting_for_agents'
            // The turn is held open by its background agents alone — say
            // so (the count), so the seat's row reads the wait, not a
            // thinking phase that ended with the stream.
            announceWait(Math.max(1, ports.waitableBackgroundTaskCount?.() ?? 1))
            // Nothing queued yet — give the background tasks a tick.
            await ports.clock.sleep(100)
          }
          // Re-enter the loop: anything newly queued drains next pass.
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
      // A thrown cycle still owes the consumer its error envelope — written
      // DIRECTLY (not enqueued) so it cannot be lost behind the shutdown.
      try {
        await ports.writeDirect(ports.onCycleError(error))
      } catch {
        // The envelope write itself failed; shutdown proceeds regardless.
      }
      ports.shutdown(1)
      return
    } finally {
      // Every exit of the cycle — settled, thrown, shut down — ends the
      // announced wait: a state word must never outlive the turn it spoke for.
      announceWait(0)
      phase = 'finally_flush'
      await ports.flushInternalEvents()
      phase = 'finally_post_flush'
      if (!ports.isShuttingDown()) {
        ports.notifySessionState('idle')
        // Drain so the idle session_state_changed event (plus any terminal
        // task_notification bookends from bg-agent teardown) reach the
        // stream before we block on the next command.
        flushSdkEvents()
      }
      phase = 'idle'
      ports.idleTimerStart()
    }

    // Re-check the queue after going idle: a message may have arrived (and
    // kicked) while the mutex still read running — that kick no-oped, so
    // the command would strand without this.
    if (ports.peek() !== undefined) {
      void kick()
      return
    }

    // Feature blocks settle what happens next (teammate inbox poll, team
    // shutdown prompting, input-closed handling).
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
    // The settle-instant recheck: a command that arrived DURING the awaited
    // settleIdle() kicked into the 'settling_idle' mutex and no-oped — the
    // same stranding class the post-cycle recheck above closes for the
    // running window, on the settle road. Without this peek a 'stay'
    // verdict left the command queued until the next unrelated stimulus.
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
