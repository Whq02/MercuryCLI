import type { SetAppState, Task, TaskStateBase } from '../../Task.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import { rollbackConsolidationLock } from '../../services/autoDream/consolidationLock.js'
import { logError } from '../../utils/log.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'


export type DreamPhase = 'starting' | 'updating'

export type DreamTurn = {
  text: string
  toolUseCount: number
}

const MAX_DREAM_TURNS = 30

const DREAM_DESCRIPTION = 'dreaming'

export type DreamTaskState = TaskStateBase & {
  type: 'dream'
  phase: DreamPhase
  sessionsReviewing: number
  filesTouched: string[]
  turns: DreamTurn[]
  abortController?: AbortController
  priorMtime: number
}

export function isDreamTask(task: unknown): task is DreamTaskState {
  return (
    typeof task === 'object' && task !== null && 'type' in task && task.type === 'dream'
  )
}

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

export function completeDreamTask(taskId: string, setAppState: SetAppState): void {
  updateTaskState<DreamTaskState>(taskId, setAppState, task => ({
    ...task,
    status: 'completed',
    notified: true,
    endTime: Date.now(),
    abortController: undefined,
  }))
}

export function failDreamTask(taskId: string, setAppState: SetAppState): void {
  updateTaskState<DreamTaskState>(taskId, setAppState, task => ({
    ...task,
    status: 'failed',
    notified: true,
    endTime: Date.now(),
    abortController: undefined,
  }))
}

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
