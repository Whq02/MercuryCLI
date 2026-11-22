import type { RunnerPorts } from './runnerPorts.js'
import type { TurnDriverPorts } from './turnDriver.js'
import type { AdvisorQuiet } from '../../services/advisor/index.js'
import type { NoticeRecord } from '../../services/notices/unreadLedger.js'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import { createAdvisorQuietMessage, type AdvisorRoad, advisorMainTurnSettled } from '../../services/advisor/index.js'
import { recordTranscript } from '../../utils/sessionStorage/writer.js'
import { logForDebugging } from '../../utils/debug.js'
import { dequeue, peek, getCommandQueue, enqueue } from '../../utils/messageQueueManager.js'
import { notifyCommandLifecycle } from '../../utils/commandLifecycle.js'
import { isOutcome } from '../../rows/read.js'
import { OUTCOME_SENTENCES } from '../../rows/vocabulary.js'
import { type RowDraft, turnStartedRow, turnWaitingRow, noticeRow, outcomeRow } from '../../rows/project.js'
import { closeRowOf } from '../../rows/turn.js'
import { ledgerMark, ledgerSpentSince } from '../../utils/ledgerMark.js'
import { drainRows } from '../../utils/sdkEventQueue.js'
import { randomUUID } from 'node:crypto'
import { getSessionId, getTotalAPIDuration } from '../../bootstrap/state.js'
import { getEngineModel } from '../../services/model/model.js'
import { logHeadlessProfilerTurn, headlessProfilerStartTurn } from '../../utils/headlessProfiler.js'
import { getRunningTasks, POLL_INTERVAL_MS } from '../../utils/task/framework.js'
import { sleep } from '../../utils/sleep.js'
import { crewmateNoticeOwed } from '../../tools/AgentTool/agentToolUtils.js'
import { leaveNoteBeforeExit } from '../../mneme/exitHandoff.js'
import { HANDOFF_ASK_BUDGET_MS } from '../../mneme/handoffAsk.js'
import { skillChangeDetector } from '../../utils/skills/skillChangeDetector.js'
import { statusListeners } from '../../services/anthropicLimits.js'
import { noteRunPhase, runPhaseReport } from '../../utils/runPhases.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { isShuttingDown, gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { EMPTY_USAGE } from '../../utils/api/emptyUsage.js'
import { errorMessage } from '../../utils/errors.js'
import { getInMemoryErrors, withoutStackFrames } from '../../utils/log.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { sessionLaneWall } from '../../tools/MonitorTool/laneWall.js'
import { startIdleNudge, MAIN_THREAD_AGENT, agentRecipientState, nudgeWords } from '../../services/notices/idleNudge.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt } from '../../pi/holes.js'

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
  return notBuilt('src/cli/headless/printDriver.ts:60')
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
