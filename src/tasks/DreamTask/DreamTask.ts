import type { SetAppState, Task, TaskStateBase } from '../../Task.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import { rollbackConsolidationLock } from '../../services/autoDream/consolidationLock.js'
import { logError } from '../../utils/log.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'

/**
 * Surfaces the memory-consolidation ("dream") subagent as a background
 * task in the footer pill and the background-task dialog.
 */

/** Phases (contract data): starting → updating, flipped by the first turn
 *  that contributes at least one newly-touched path. */
export type DreamPhase = 'starting' | 'updating'

/** One collapsed assistant turn: its text plus a tool-use count. The prompt
 *  is never included. */
export type DreamTurn = {
  text: string
  toolUseCount: number
}

/** Bounded turn history (contract data): at most 30, oldest dropped. */
const MAX_DREAM_TURNS = 30

/** The fixed one-word description — the same word the pill shows. */
const DREAM_DESCRIPTION = 'dreaming'

export type DreamTaskState = TaskStateBase & {
  type: 'dream'
  phase: DreamPhase
  /** How many sessions this consolidation is reviewing. */
  sessionsReviewing: number
  /**
   * Paths observed in edit/write tool-use blocks as they streamed past —
   * deliberately PARTIAL (shell writes are invisible to it). A lower bound
   * on what changed, never the complete set.
   */
  filesTouched: string[]
  turns: DreamTurn[]
  abortController?: AbortController
  /** The consolidation lock's modification time before this run. */
  priorMtime: number
}

export function isDreamTask(task: unknown): task is DreamTaskState {
  return (
    typeof task === 'object' && task !== null && 'type' in task && task.type === 'dream'
  )
}

/** Register the dream task: fixed one-word description, status running. */
export function registerDreamTask(
  setAppState: SetAppState,
  args: {
    sessionsReviewing: number
    priorMtime: number
    abortController: AbortController
  },
): string {
  const taskId = generateTaskId('dream')
  const state: DreamTaskState = {
    ...createTaskStateBase(taskId, 'dream', DREAM_DESCRIPTION),
    type: 'dream',
    status: 'running',
    phase: 'starting',
    sessionsReviewing: args.sessionsReviewing,
    filesTouched: [],
    turns: [],
    abortController: args.abortController,
    priorMtime: args.priorMtime,
  }
  registerTask(state, setAppState)
  return taskId
}

/**
 * Record one assistant turn. Newly-touched paths are deduplicated against
 * those already recorded; an empty turn (no text, no tool uses) that
 * touches nothing new skips the state update entirely; the turn list is
 * trimmed to the cap as each turn is appended. The phase flips from
 * starting to updating on the first turn contributing at least one
 * newly-touched path — a turn that only repeats known paths does not flip
 * it.
 */
export function addDreamTurn(
  taskId: string,
  turn: DreamTurn,
  touchedPaths: string[],
  setAppState: SetAppState,
): void {
  updateTaskState<DreamTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    const known = new Set(task.filesTouched)
    const newlyTouched = touchedPaths.filter(path => !known.has(path))
    const emptyTurn = turn.text === '' && turn.toolUseCount === 0
    if (emptyTurn && newlyTouched.length === 0) return task
    const turns = [...task.turns, turn]
    if (turns.length > MAX_DREAM_TURNS) turns.splice(0, turns.length - MAX_DREAM_TURNS)
    return {
      ...task,
      phase: newlyTouched.length > 0 ? 'updating' : task.phase,
      filesTouched:
        newlyTouched.length > 0 ? [...task.filesTouched, ...newlyTouched] : task.filesTouched,
      turns,
    }
  })
}

/**
 * Complete the dream task. Notified is set immediately — the task framework
 * only releases a task that is both finished and notified, and this task
 * never sends the model anything (its only audience is the user, told
 * inline by a system message). Deliberately NOT guarded on the task still
 * running: completing an already-terminal dream task rewrites its status.
 */
export function completeDreamTask(taskId: string, setAppState: SetAppState): void {
  updateTaskState<DreamTaskState>(taskId, setAppState, task => ({
    ...task,
    status: 'completed',
    notified: true,
    endTime: Date.now(),
    abortController: undefined,
  }))
}

/** Fail the dream task — same unguarded shape as complete. */
export function failDreamTask(taskId: string, setAppState: SetAppState): void {
  updateTaskState<DreamTaskState>(taskId, setAppState, task => ({
    ...task,
    status: 'failed',
    notified: true,
    endTime: Date.now(),
    abortController: undefined,
  }))
}

/**
 * Kill a running dream task (guarded, unlike complete/fail): abort, mark
 * killed + notified, then rewind the consolidation lock's modification
 * time so the next session can retry — the same path as a fork failure. A
 * no-op update (already terminal) skips the rewind.
 */
function killDreamTask(taskId: string, setAppState: SetAppState): void {
  let priorMtime: number | undefined
  updateTaskState<DreamTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    priorMtime = task.priorMtime
    task.abortController?.abort()
    return {
      ...task,
      status: 'killed',
      notified: true,
      endTime: Date.now(),
      abortController: undefined,
    }
  })
  if (priorMtime !== undefined) {
    rollbackConsolidationLock(priorMtime).catch(error => {
      logError(error)
    })
  }
}

export const DreamTask: Task = {
  name: 'DreamTask',
  type: 'dream',
  async kill(taskId, setAppState) {
    killDreamTask(taskId, setAppState)
  },
}
