import type { RunnerPorts } from './runnerPorts.js'
import { getSessionId } from '../../bootstrap/state.js'
import { getCwd } from '../../utils/cwd.js'
import { logError } from '../../utils/log.js'
import { processMainOwner } from '../../services/run/resolveOwner.js'
import { getRunSnapshot, reconcileOnResume } from '../../services/run/runCoordinator.js'
import { logForDebugging } from '../../utils/debug.js'
import { runningBuildTree } from '../../utils/artifactIdentity.js'
import { appendSessionReceipt } from '../../services/switchboard/sessionReceipts.js'
import { dirname } from 'node:path'
import { getTranscriptPath } from '../../utils/sessionStorage/paths.js'
import { wrapInSystemReminder } from '../../utils/messages/text.js'
import { noticeRow } from '../../rows/project.js'

export async function hydrateResumedRun(ports: RunnerPorts): Promise<void> {
  const { asks, enqueueRow, getAppState, live, liveScope, messages, relaunchContext, setAppState } = ports
  if (messages.length === 0) return
  try {
    const { runBootRecovery } = await import('../../substrate/recoveryOrchestrator.js')
    await runBootRecovery({
      scope: 'session',
      sessionId: getSessionId(),
      projectDir: getCwd(),
    })
  } catch (error) {
    logError(error)
  }
  try {
    const owner = processMainOwner()
    if (getRunSnapshot(owner) === null) {
      await reconcileOnResume(owner, getCwd())
    }
  } catch (error) {
    logError(error)
  }
  try {
    const { coerceRestartReason: carriedReasonOf } = await import('../../tasks/LocalAgentTask/launchReceipts.js')
    const carriedReason = carriedReasonOf(live.runnerRestartReason)
    if (carriedReason === 'crash' || carriedReason === 'stop' || carriedReason === 'update' || carriedReason === 'ended') {
      const { carryRunnerAcrossRestart } = await import('./restartCarry.js')
      const carried = await carryRunnerAcrossRestart({
        reason: carriedReason,
        messages,
        getAppState,
        setAppState,
        canUseTool: asks.createCanUseTool(),
        relaunchContext,
      })
      live.recoveredCommandIds = carried.recoveredCommandIds
      logForDebugging(`[session-runner] resume after ${carriedReason}: ${carried.requeued} line(s) re-queued, ${carried.relaunched} agent(s) relaunched, ${carried.delivered} delivered from the queue log, ${carried.stopped} stopped`)
    }
  } catch (error) {
    logError(error)
  }
  try {
    const { reconcileBackgroundLaunchesOnResume, coerceRestartReason } = await import('../../tasks/LocalAgentTask/launchReceipts.js')
    const settledLaunches = reconcileBackgroundLaunchesOnResume(messages, getAppState, setAppState, Date.now(), coerceRestartReason(live.runnerRestartReason))
    if (settledLaunches.length > 0) {
      logForDebugging(`[session-runner] resume: ${settledLaunches.length} background launch(es) without a live record — stop notices written`)
    }
  } catch (error) {
    logError(error)
  }
  try {
    const { carryPausedCrewmatesOnResume } = await import('../../tasks/LocalAgentTask/pauseCarry.js')
    const carried = await carryPausedCrewmatesOnResume({
      getAppState,
      setAppState,
      canUseTool: asks.createCanUseTool(),
      relaunchContext,
    })
    if (carried.length > 0) {
      logForDebugging(`[session-runner] resume: ${carried.length} paused crewmate(s) re-armed to retry at their stated reset — ${carried.join(', ')}`)
    }
  } catch (error) {
    logError(error)
  }
  try {
    const { reconcileWatchesOnResume, reconcileBackgroundShellsOnResume, composeRestartLine } = await import('../../tools/MonitorTool/watchReceipts.js')
    const { coerceRestartReason } = await import('../../tasks/LocalAgentTask/launchReceipts.js')
    const reason = coerceRestartReason(live.runnerRestartReason)
    const liveIds = new Set(Object.keys(getAppState().tasks ?? {}))
    const { reconcileTaskLaunchesOnResume } = await import('../../tasks/taskLaunchLedger.js')
    const launches = await reconcileTaskLaunchesOnResume(String(getSessionId()), liveIds)
    if (launches.endedPids.length > 0) {
      logForDebugging(`[session-runner] resume: ${launches.endedPids.length} background process(es) had outlived the runner and were ended — pids ${launches.endedPids.join(', ')}`)
    }
    const deadWatches = reconcileWatchesOnResume(messages, liveIds, reason, launches.orphans, launches.settledTaskIds)
    const deadShells = reconcileBackgroundShellsOnResume(messages, liveIds, reason, launches.orphans, launches.settledTaskIds)
    if (deadWatches.length > 0 || deadShells.length > 0) {
      logForDebugging(`[session-runner] resume: ${deadWatches.length} watch(es) and ${deadShells.length} background shell(s) without a live process — dead notices written`)
    }
    if (reason === 'update' || reason === 'ended') {
      const build = runningBuildTree() ?? `v${MACRO.VERSION}`
      const line = composeRestartLine({ reason, build, watches: deadWatches, shells: deadShells })
      try {
        appendSessionReceipt(dirname(getTranscriptPath()), String(getSessionId()), {
          at: new Date().toISOString(),
          by: 'runner',
          kind: 'runner-restart',
          summary: line,
          details: { reason, build, watches: deadWatches.length, shells: deadShells.length },
        })
      } catch (error) {
        logError(error)
      }
      const { enqueuePendingNotification } = await import('../../utils/messageQueueManager.js')
      enqueuePendingNotification({
        value: wrapInSystemReminder(line),
        mode: 'task-notification',
        priority: 'next',
        ridesNextWords: true,
      })
      enqueueRow(noticeRow(liveScope(), 'warning', line))
    }
  } catch (error) {
    logError(error)
  }
}
