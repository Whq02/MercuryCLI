import { randomBytes } from 'node:crypto'
import { TASK_ID_ALPHABET, TASK_ID_SUFFIX_LENGTH } from './types/ids.js'
import { getTaskOutputPath } from './utils/task/diskOutput.js'
import type { AppState } from './state/AppState.js'
import type { TaskRow } from './rows/vocabulary.js'
import { notBuilt, type Unbuilt } from './pi/holes.js'

const taskKinds = [
  ['local_bash', 'b'],
  ['local_agent', 'a'],
  ['remote_agent', 'r'],
  ['monitor_mcp', 'm'],
] as const
const taskPrefixes = Object.fromEntries(taskKinds)

export type TaskType = Unbuilt
export type TaskStatus = Unbuilt

export function generateTaskId(type: TaskType): string {
  return notBuilt('src/Task.ts:18')
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return notBuilt('src/Task.ts:27')
}

type TaskStart = Pick<TaskRow, 'task_id' | 'call_id'> & { task_type: TaskType; description: string }
type TaskProgress = Record<'startTime' | 'outputOffset', number> &
  Partial<Record<'endTime' | 'totalPausedMs', number>> & { outputFile: string; notified: boolean }
export type TaskStateBase = Unbuilt

function beginTaskProgress(id: string): TaskProgress {
  const startTime = Date.now()
  const outputFile = getTaskOutputPath(id)
  return { startTime, outputFile, outputOffset: 0, notified: false }
}

export function createTaskStateBase({ task_id, task_type, description, call_id }: TaskStart): TaskStateBase {
  const identity = { id: task_id, type: task_type, status: 'pending' as TaskStatus, description, toolUseId: call_id }
  return Object.assign(identity, beginTaskProgress(task_id))
}

export type SetAppState = (...args: Unbuilt[]) => Unbuilt
export type TaskContext = Unbuilt
export type TaskHandle = Unbuilt
export type Task = Unbuilt

export type LocalShellSpawnInput = Unbuilt

export type TaskKillReceipt = { settled: boolean } & Partial<
  Record<'exitCode' | 'processesEnded' | 'processSurvivors', number> &
  { interrupted: boolean; reason: string }
>
