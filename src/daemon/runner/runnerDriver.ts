import type { RunnerPorts } from './runnerPorts.js'
import type { TurnDriverPorts } from './turnDriver.js'
import type { AdvisorQuiet } from '../../models/advisor/index.js'
import type { NoticeRecord } from '../../sessions/notices/unreadLedger.js'
import type { QueuedCommand } from '../../screen/composer/input-core/textInput.js'
import { createAdvisorQuietMessage, type AdvisorRoad, advisorMainTurnSettled } from '../../models/advisor/index.js'
import { recordTranscript } from '../../sessions/transcripts/writer.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { dequeue, peek, getCommandQueue, enqueue } from './messageQueueManager.js'
import { notifyCommandLifecycle } from './commandLifecycle.js'
import { isOutcome } from '../../engine/rows/read.js'
import { OUTCOME_SENTENCES } from '../../engine/rows/vocabulary.js'
import { type RowDraft, turnStartedRow, turnWaitingRow, noticeRow, outcomeRow } from '../../engine/rows/project.js'
import { closeRowOf } from '../../engine/rows/turn.js'
import { ledgerMark, ledgerSpentSince } from '../../engine/rows/turn/ledgerMark.js'
import { drainRows } from './sdkEventQueue.js'
import { randomUUID } from 'node:crypto'
import { getSessionId, getTotalAPIDuration } from '../../boot/process-state/processState.js'
import { getEngineModel } from '../../models/catalogue/engineModel.js'
import { logHeadlessProfilerTurn, headlessProfilerStartTurn } from '../../platform/logs/headlessProfiler.js'
import { getRunningTasks, POLL_INTERVAL_MS } from '../../engine/task-framework/taskRegistry.js'
import { sleep } from '../../platform/async/sleep.js'
import { crewmateNoticeOwed } from '../../tools/crewmate/crewmateLifecycle.js'
import { leaveNoteBeforeExit } from '../../sessions/mneme/exitHandoff.js'
import { HANDOFF_ASK_BUDGET_MS } from '../../sessions/mneme/handoffAsk.js'
import { skillChangeDetector } from '../../integrations/skill-watch/skillChangeDetector.js'
import { statusListeners } from '../../models/roads/anthropic/anthropicLimits.js'
import { noteRunPhase, runPhaseReport } from '../../platform/logs/runPhases.js'
import { jsonStringify } from '../../platform/logs/slowOperations.js'
import { isShuttingDown, gracefulShutdown } from '../../platform/processes/gracefulShutdown.js'
import { EMPTY_USAGE } from '../../engine/request-parts/emptyUsage.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { getInMemoryErrors, withoutStackFrames } from '../../platform/logs/errorLog.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { sessionLaneWall } from '../../tools/monitor/laneWall.js'
import { startIdleNudge, MAIN_THREAD_AGENT, agentRecipientState, nudgeWords } from '../../sessions/notices/idleNudge.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export function landAdvisorQuiet(quiet: AdvisorQuiet, ports: RunnerPorts): void {
  const { messages } = ports
  const row = createAdvisorQuietMessage(quiet)
  messages.push(row)
  void recordTranscript([row], undefined, messages).catch((error: unknown) => {
    logForDebugging(`advisor: the quiet row was not recorded — ${error instanceof Error ? error.message : String(error)}`)
  })
}

export function advisorRoadOf(ports: RunnerPorts): AdvisorRoad {
  const { landAdvisorQuiet, live } = ports
  const advisorRoad: AdvisorRoad = {
    onQuiet: quiet => {
      if (live.inputClosed) return
      if (live.inFlightAbort !== null) live.deferredAdvisorQuiet.push(quiet)
      else landAdvisorQuiet(quiet)
    },
  }
  return advisorRoad
}

export function printDriverPorts(ports: RunnerPorts): TurnDriverPorts {
  const { advisorRoad, bootReady, disarmAgentFreshness, enqueueRow, executeTurn, getAppState, idleTimeout, io, isConcourseWorker, isLocalShellTask, isMainThreadCommand, live, liveScope, maxTime, messages, rateLimitListener, settleIdle, stopDrainedNotificationFrames, takeMainThread, writeLine } = ports
  return {
    dequeue: takeMainThread,
    dequeueCommand: command => dequeue(queued => queued === command),
    peek: () => peek(isMainThreadCommand),
    notifyLifecycle: notifyCommandLifecycle,
    enqueueOutput: message => {
      if (isOutcome(message) && message.status === 'completed' && maxTime !== undefined && Date.now() >= maxTime.at) {
        io.outbound.enqueue({ ...message, status: 'time_limit', error: { class: 'time_limit', message: OUTCOME_SENTENCES.time_limit({ maxTimeMs: maxTime.limitMs }) } } as RowDraft)
      } else io.outbound.enqueue(message)
    },
    writeDirect: async message => {
      await writeLine(message)
    },
    drainRows: () => drainRows().map(row => ({ ...row, ...(live.currentTurn !== null ? { turn: live.currentTurn } : {}) }) as RowDraft),
    beforeCycle: () => bootReady,
    onTurnStart: () => {
      live.currentTurnId = null
    },
    turnIdOf: () => {
      if (live.currentTurnId === null) live.currentTurnId = randomUUID()
      return live.currentTurnId
    },
    openTurnRow: messageIds => {
      if (live.currentTurnId === null) live.currentTurnId = randomUUID()
      return turnStartedRow({ session_id: getSessionId(), turn: live.currentTurn ?? live.turnsRun }, { turnId: live.currentTurnId, messageIds, model: live.activeModel ?? getEngineModel() })
    },
    executeTurn: (command, batch, onMessage, initialNotices) =>
      executeTurn(command, batch, message => {
        if (message.type === 'block_start') ports.party.blockOpen()
        else if (message.type === 'text' || message.type === 'reasoning' || message.type === 'tool_call') ports.party.landed()
        onMessage(message)
      }, initialNotices),
    onTurnSettled: command => {
      logHeadlessProfilerTurn()
      headlessProfilerStartTurn()
      if (live.turnReachedModel) void advisorMainTurnSettled(String(getSessionId()), command, messages, advisorRoad)
    },
    hasWaitableBackgroundTasks: () =>
      getRunningTasks(getAppState()).some(task => !(live.inputClosed && isLocalShellTask(task))) || (live.inputClosed && (ports.swarmResumes.hasPending() || crewmateNoticeOwed())),
    hasHoldableBackgroundAgents: () =>
      getRunningTasks(getAppState()).some(
        task => task.type === 'local_agent',
      ),
    waitableBackgroundTaskCount: () =>
      getRunningTasks(getAppState()).filter(task => !(live.inputClosed && isLocalShellTask(task))).length + (live.inputClosed ? ports.swarmResumes.waitingSeats() : 0),
    onAgentWait: (count, turnId) => {
      enqueueRow(turnWaitingRow({ session_id: getSessionId(), turn: live.turnsRun }, { turnId, agents: count }))
    },
    settleIdle,
    wakeSettle: () => {},
    beforeCloseOutput: async () => {
      if (isConcourseWorker) return
      const { exitNoteDue } = await import('../../sessions/mneme/exitHandoff.js')
      const ranHere = exitNoteDue()
      let closeUsage: import('../../engine/request-parts/emptyUsage.js').NonNullableUsage | undefined
      const beforeNote = ledgerMark()
      const outcome = await leaveNoteBeforeExit({
        budgetMs: HANDOFF_ASK_BUDGET_MS,
        onNotice: text => io.outbound.enqueue(noticeRow(liveScope(), 'warning', text)),
        onUsage: usage => { closeUsage = usage },
      })
      if (ranHere) io.outbound.enqueue(closeRowOf(liveScope(), { closeState: outcome, ...(closeUsage !== undefined ? { usage: closeUsage } : {}), spent: ledgerSpentSince(beforeNote) }))
    },
    closeOutput: async () => {
      const { endBackgroundHooks } = await import('../../integrations/event-hooks/background.js')
      await endBackgroundHooks().catch(passedOver)
      skillChangeDetector.dispose()
      disarmAgentFreshness()
      stopDrainedNotificationFrames()
      ports.stopSdkDrain()
      statusListeners.delete(rateLimitListener)
      noteRunPhase('flush_exit')
      logForDebugging(`[run-phases] ${jsonStringify(runPhaseReport(getTotalAPIDuration()))}`)
      io.outbound.done()
    },
    isShuttingDown,
    idleTimerStop: () => idleTimeout.stop?.(),
    idleTimerStart: () => idleTimeout.start?.(),
    onCycleError: (error, turnId) =>
      outcomeRow(
        { session_id: getSessionId(), turn: live.currentTurn ?? Math.max(1, live.turnsRun) },
        {
          turnId,
          status: 'failed',
          steps: 0,
          wallMs: 0,
          usage: EMPTY_USAGE,
          models: {},
          denials: [],
          error: { message: errorMessage(error), class: 'internal', detail: getInMemoryErrors().map(entry => withoutStackFrames(entry.error)) },
        },
      ),
    shutdown: code => void gracefulShutdown(code),
    clock: { sleep: ms => sleep(ms) },
    queuedMainThread: () => getCommandQueue().filter(isMainThreadCommand),
    settleWindowMs: Math.max(POLL_INTERVAL_MS, Number.parseInt(flagEnv('MERCURY_SETTLE_WINDOW_MS') ?? '', 10) || 0),
    wall: () => sessionLaneWall(),
  }
}

export function carriersOf(notices: readonly NoticeRecord[]): QueuedCommand[] {
  const keys = new Set<string>()
  for (const notice of notices) {
    keys.add(notice.key)
    if (notice.altKey !== undefined) keys.add(notice.altKey)
  }
  return getCommandQueue().filter(
    command => (command.queueId !== undefined && keys.has(command.queueId)) || (command.uuid !== undefined && keys.has(String(command.uuid))),
  )
}

export function startRunnerIdleNudge(ports: RunnerPorts): ReturnType<typeof startIdleNudge> {
  const { carriersOf, driver, getAppState, live, retireQueuedCommands } = ports
  const idleNudge = startIdleNudge({
    recipient: agentId => {
      if (agentId !== MAIN_THREAD_AGENT) return agentRecipientState(getAppState().tasks, agentId)
      if (isShuttingDown()) return { state: 'gone', why: 'the session is shutting down' }
      if (live.inputClosed) return { state: 'gone', why: "the session's input closed" }
      if (sessionLaneWall().closed) return { state: 'busy' }
      return !live.sessionInitialized || driver.isRunning() ? { state: 'busy' } : { state: 'idle' }
    },
    wake: (agentId, notices) => {
      const waitedMs = Date.now() - Math.min(...notices.map(notice => notice.deliveredAtMs))
      if (agentId === MAIN_THREAD_AGENT) {
        enqueue({ value: nudgeWords(notices, waitedMs), mode: 'prompt', priority: 'later', isMeta: true, uuid: randomUUID() })
        driver.endOperatorWait()
        return true
      }
      return false
    },
    discard: notices => {
      const carriers = carriersOf(notices)
      if (carriers.length > 0) retireQueuedCommands(carriers)
    },
  })
  return idleNudge
}
