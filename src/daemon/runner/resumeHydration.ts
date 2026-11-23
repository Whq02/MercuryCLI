import type { RunnerPorts } from './runnerPorts.js'
import { getSessionId } from '../../boot/process-state/processState.js'
import { getCwd } from '../../platform/files/cwd.js'
import { logError } from '../../platform/logs/errorLog.js'
import { processMainOwner } from '../../engine/run-owner/resolveOwner.js'
import { getRunSnapshot, reconcileOnResume } from '../../engine/run/runCoordinator.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { runningBuildTree } from '../../platform/product/artifactIdentity.js'
import { appendSessionReceipt } from '../switchboard/sessionReceipts.js'
import { dirname } from 'node:path'
import { getTranscriptPath } from '../../sessions/transcripts/paths.js'
import { wrapInSystemReminder } from '../../engine/message-shapes/text.js'
import { noticeRow } from '../../engine/rows/project.js'

export async function hydrateResumedRun(ports: RunnerPorts): Promise<void> {
  const { asks, enqueueRow, getAppState, live, liveScope, messages, relaunchContext, setAppState } = ports
  if (messages.length === 0) return
  try {
    const { runBootRecovery } = await import('../../platform/substrate/recoveryOrchestrator.js')
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
    const { coerceRestartReason: carriedReasonOf } = await import('../../engine/tasks/local-agent/launchReceipts.js')
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
    const { reconcileBackgroundLaunchesOnResume, coerceRestartReason } = await import('../../engine/tasks/local-agent/launchReceipts.js')
    const settledLaunches = reconcileBackgroundLaunchesOnResume(messages, getAppState, setAppState, Date.now(), coerceRestartReason(live.runnerRestartReason))
    if (settledLaunches.length > 0) {
      logForDebugging(`[session-runner] resume: ${settledLaunches.length} background launch(es) without a live record — stop notices written`)
    }
  } catch (error) {
    logError(error)
  }
  try {
    const { carryPausedCrewmatesOnResume } = await import('../../engine/tasks/local-agent/pauseCarry.js')
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
    const { reconcileWatchesOnResume, reconcileBackgroundShellsOnResume, composeRestartLine } = await import('../../tools/monitor/watchReceipts.js')
    const { coerceRestartReason } = await import('../../engine/tasks/local-agent/launchReceipts.js')
    const reason = coerceRestartReason(live.runnerRestartReason)
    const liveIds = new Set(Object.keys(getAppState().tasks ?? {}))
    const { reconcileTaskLaunchesOnResume } = await import('../../engine/tasks/taskLaunchLedger.js')
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
      const { enqueuePendingNotification } = await import('./messageQueueManager.js')
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
