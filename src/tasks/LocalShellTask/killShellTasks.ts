import type { SetAppState } from '../../Task.js'
import type { AppState } from '../../state/AppState.js'
import type { ExecResult, ShellCommand } from '../../utils/ShellCommand.js'
import type { ProcessTreeKillReceipt } from '../../utils/processGroup.js'
import { withDeadline } from '../../utils/deadline.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { dequeueAllMatching } from '../../utils/messageQueueManager.js'
import { evictTaskOutput } from '../../utils/task/diskOutput.js'
import { stopTimeout } from '../../utils/timers.js'
import { isLocalShellTask, type ShellKillSource } from './guards.js'

const SETTLEMENT_GRACE_MS = 3_000
const TREE_RECEIPT_DEADLINE_MS = 1_500

type KillSettlement =
  | {
      settled: true
      exitCode: number
      interrupted: boolean
      processesEnded?: number
      processSurvivors?: number
    }
  | { settled: true; exitCode: undefined; reason: 'not-running' }
  | { settled: false; reason: 'settlement-grace-expired' }

export async function killTask(
  taskId: string,
  setAppState: SetAppState,
  killedBy: ShellKillSource = 'operator',
): Promise<KillSettlement> {
  const captured: {
    wasRunning: boolean
    shellCommand: ShellCommand | null
    unregisterCleanup: (() => void) | undefined
    cleanupTimeoutId: NodeJS.Timeout | undefined
  } = {
    wasRunning: false,
    shellCommand: null,
    unregisterCleanup: undefined,
    cleanupTimeoutId: undefined,
  }

  setAppState((prev: AppState) => {
    const task = prev.tasks?.[taskId]
    if (!isLocalShellTask(task) || task.status !== 'running') {
      return prev
    }
    captured.wasRunning = true
    captured.shellCommand = task.shellCommand
    captured.unregisterCleanup = task.unregisterCleanup
    captured.cleanupTimeoutId = task.cleanupTimeoutId
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: {
          ...task,
          status: 'killed',
          killedBy,
          notified: true,
          shellCommand: null,
          unregisterCleanup: undefined,
          cleanupTimeoutId: undefined,
          endTime: Date.now(),
        },
      },
    }
  })

  if (!captured.wasRunning) {
    void evictTaskOutput(taskId)
    return { settled: true, exitCode: undefined, reason: 'not-running' }
  }

  void evictTaskOutput(taskId)

  const handle = captured.shellCommand
  const resultPromise: Promise<ExecResult> | undefined = handle?.result
  let treeKillReceipt: Promise<ProcessTreeKillReceipt> | undefined

  if (handle) {
    try {
      handle.kill()
      treeKillReceipt = handle.treeKillReceipt
    } catch (error) {
      logError(error)
    }
  }

  if (captured.unregisterCleanup) {
    try {
      captured.unregisterCleanup()
    } catch (error) {
      logError(error)
    }
  }

  if (captured.cleanupTimeoutId !== undefined) {
    try {
      stopTimeout(captured.cleanupTimeoutId)
    } catch (error) {
      logError(error)
    }
  }

  const cleanupHandle = (): void => {
    if (!handle) return
    try {
      handle.cleanup()
    } catch (error) {
      logError(error)
    }
  }

  if (!resultPromise) {
    cleanupHandle()
    return { settled: true, exitCode: undefined, reason: 'not-running' }
  }

  let result: ExecResult | null = null
  try {
    result = await withDeadline(
      resultPromise,
      SETTLEMENT_GRACE_MS,
      () => null,
      { unref: true },
    )
  } catch (error) {
    logError(error)
    result = null
  } finally {
    cleanupHandle()
  }
  if (result === null) {
    return { settled: false, reason: 'settlement-grace-expired' }
  }

  let counts: { processesEnded?: number; processSurvivors?: number } = {}
  if (treeKillReceipt) {
    try {
      const receipt = await withDeadline(
        treeKillReceipt,
        TREE_RECEIPT_DEADLINE_MS,
        () => null,
        { unref: true },
      )
      if (receipt !== null) {
        counts = {
          processesEnded: receipt.ended,
          ...(receipt.survivors.length > 0
            ? { processSurvivors: receipt.survivors.length }
            : {}),
        }
      }
    } catch (error) {
      logError(error)
    }
  }

  return {
    settled: true,
    exitCode: result.code,
    interrupted: result.interrupted,
    ...counts,
  }
}

export function killShellTasksForAgent(
  agentId: string | undefined,
  getAppState: () => AppState,
  setAppState: SetAppState,
): void {
  const tasks = getAppState().tasks ?? {}
  for (const [taskId, task] of Object.entries(tasks)) {
    if (
      isLocalShellTask(task) &&
      task.status === 'running' &&
      task.agentId === agentId
    ) {
      logForDebugging(`killing orphaned shell task ${taskId}`)
      void killTask(taskId, setAppState, 'agent-end')
    }
  }
  dequeueAllMatching(cmd => cmd.agentId === agentId)
}
