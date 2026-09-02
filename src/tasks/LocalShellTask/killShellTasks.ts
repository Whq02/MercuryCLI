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

/**
 * Kill a shell task with a settlement receipt, and sweep an agent's
 * orphaned shell tasks when its loop unwinds.
 */

/** How long the kill waits for the process group to genuinely go away. */
const KILL_SETTLEMENT_GRACE_MS = 3000

/** How long the settled arm waits for the tree sweep's counted receipt —
 *  the sweep's own reap bound plus its walk, and well inside the grace. */
const TREE_RECEIPT_BOUND_MS = 1500

/**
 * The kill settlement vocabulary (contract data for the reason strings):
 * the process settled with a code and the stop's provenance; there was
 * nothing live to kill; or nobody can tell within the allotted time. A
 * settled kill also says how many processes the stop ended — the whole
 * tree, not just the leader — and how many pids outlived the bounded reap,
 * when any did. `interrupted` is the shell result's own flag: true when
 * this stop ended the process, false when it had settled on its own first;
 * the code beside it is the platform's detail, never the provenance.
 */
export type KillSettlement =
  | { settled: true; exitCode: number; interrupted: boolean; processesEnded?: number; processSurvivors?: number }
  | { settled: true; exitCode: undefined; reason: 'not-running' }
  | { settled: false; reason: 'settlement-grace-expired' }

/**
 * Kill a shell task. Two separate facts at two different times: the state
 * flip to killed is synchronous (what the user sees, the moment they ask);
 * the returned promise resolves only once the process group has genuinely
 * gone away, or says plainly that nobody can tell within the grace.
 *
 * The killed status and the notified flag land in the same atomic state
 * update, which is what suppresses the settlement handler's stopped notice.
 * The output-writer release runs unconditionally — even for a missing,
 * finished or non-shell task.
 */
export function killTask(taskId: string, setAppState: SetAppState): Promise<KillSettlement> {
  let resultPromise: Promise<{ code: number; interrupted: boolean }> | null = null
  let handleToKill: LocalShellTaskState['shellCommand'] = null
  let cleanupToRun: (() => void) | undefined
  let timerToClear: ReturnType<typeof setTimeout> | undefined
  let killed = false

  updateTaskState<LocalShellTaskState>(taskId, setAppState, task => {
    if (!isLocalShellTask(task) || task.status !== 'running') return task
    killed = true
    // Capture the live result promise BEFORE killing — it is the settlement
    // signal.
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

  // Flush and deregister the writer regardless of what the update did — the
  // file itself is kept; the model can still read it afterwards.
  void evictTaskOutput(taskId)

  if (!killed) {
    return Promise.resolve({ settled: true, exitCode: undefined, reason: 'not-running' })
  }

  // Side effects outside the state reducer. The tree receipt is captured
  // between kill() (which mints it) and cleanup() (which releases the child).
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

  // The sweep's counted receipt, bounded so a stuck walk can never hold the
  // settlement past its grace. Absent receipt (no kill ran) → no counts.
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
        // A rejecting result promise cannot settle honestly either way.
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ settled: false, reason: 'settlement-grace-expired' })
      },
    )
  })
}

/**
 * Kill every running shell task spawned by the given agent (invoked as that
 * agent's loop unwinds, so nothing it started keeps running after it is
 * gone), then discard any queued notifications addressed to it — nothing
 * will ever drain that queue again. The sweep does not wait for the kills;
 * notifications they produce afterwards are inert.
 */
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
