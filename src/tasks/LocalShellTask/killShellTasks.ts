import type { SetAppState } from '../../Task.js'
import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../../utils/debug.js'
import type { ProcessTreeKillReceipt } from '../../utils/processGroup.js'
import { logError } from '../../utils/log.js'
import { dequeueAllMatching } from '../../utils/messageQueueManager.js'
import { evictTaskOutput } from '../../utils/task/diskOutput.js'
import { updateTaskState } from '../../utils/task/framework.js'
import type { LocalShellTaskState } from './guards.js'
import { isLocalShellTask } from './guards.js'


const KILL_SETTLEMENT_GRACE_MS = 3000

const TREE_RECEIPT_BOUND_MS = 1500

export type KillSettlement =
  | { settled: true; exitCode: number; interrupted: boolean; processesEnded?: number; processSurvivors?: number }
  | { settled: true; exitCode: undefined; reason: 'not-running' }
  | { settled: false; reason: 'settlement-grace-expired' }

export function killTask(taskId: string, setAppState: SetAppState): Promise<KillSettlement> {
  let resultPromise: Promise<{ code: number; interrupted: boolean }> | null = null
  let handleToKill: LocalShellTaskState['shellCommand'] = null
  let cleanupToRun: (() => void) | undefined
  let timerToClear: ReturnType<typeof setTimeout> | undefined
  let killed = false

  updateTaskState<LocalShellTaskState>(taskId, setAppState, task => {
    if (!isLocalShellTask(task) || task.status !== 'running') return task
    killed = true
    resultPromise = task.shellCommand ? task.shellCommand.result : null
    handleToKill = task.shellCommand
    cleanupToRun = task.unregisterCleanup
    timerToClear = task.cleanupTimeoutId
    return {
      ...task,
      status: 'killed',
      notified: true,
      shellCommand: null,
      unregisterCleanup: undefined,
      cleanupTimeoutId: undefined,
      endTime: Date.now(),
    }
  })

  void evictTaskOutput(taskId)

  if (!killed) {
    return Promise.resolve({ settled: true, exitCode: undefined, reason: 'not-running' })
  }

  let treeReceipt: Promise<ProcessTreeKillReceipt> | undefined
  if (handleToKill) {
    try {
      ;(handleToKill as { kill: () => void }).kill()
      treeReceipt = (handleToKill as { treeKillReceipt?: Promise<ProcessTreeKillReceipt> })
        .treeKillReceipt
      ;(handleToKill as { cleanup: () => void }).cleanup()
    } catch (error) {
      logError(error)
    }
  }
  try {
    cleanupToRun?.()
  } catch (error) {
    logError(error)
  }
  if (timerToClear !== undefined) clearTimeout(timerToClear)

  if (!resultPromise) {
    return Promise.resolve({ settled: true, exitCode: undefined, reason: 'not-running' })
  }

  const treeCounts = async (): Promise<{ processesEnded?: number; processSurvivors?: number }> => {
    if (!treeReceipt) return {}
    try {
      const receipt = await Promise.race([
        treeReceipt,
        new Promise<null>(resolve => {
          const bound = setTimeout(() => resolve(null), TREE_RECEIPT_BOUND_MS)
          bound.unref?.()
        }),
      ])
      if (!receipt) return {}
      return {
        processesEnded: receipt.ended,
        ...(receipt.survivors.length > 0 ? { processSurvivors: receipt.survivors.length } : {}),
      }
    } catch {
      return {}
    }
  }

  return new Promise<KillSettlement>(resolve => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolve({ settled: false, reason: 'settlement-grace-expired' })
    }, KILL_SETTLEMENT_GRACE_MS)
    timer.unref?.()
    ;(resultPromise as Promise<{ code: number; interrupted: boolean }>).then(
      async result => {
        if (done) return
        const counts = await treeCounts()
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ settled: true, exitCode: result.code, interrupted: result.interrupted, ...counts })
      },
      () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ settled: false, reason: 'settlement-grace-expired' })
      },
    )
  })
}

export function killShellTasksForAgent(
  agentId: string | undefined,
  getAppState: () => AppState,
  setAppState: SetAppState,
): void {
  const tasks = getAppState().tasks ?? {}
  for (const task of Object.values(tasks)) {
    if (!isLocalShellTask(task)) continue
    if (task.status !== 'running') continue
    if (task.agentId !== agentId) continue
    logForDebugging(`killing orphaned shell task ${task.id} for agent ${agentId}`)
    void killTask(task.id, setAppState)
  }
  dequeueAllMatching(cmd => cmd.agentId === agentId)
}
