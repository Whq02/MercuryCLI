import { randomBytes } from 'node:crypto'
import { TASK_ID_ALPHABET, TASK_ID_SUFFIX_LENGTH } from './types/ids.js'
import { getTaskOutputPath } from './utils/task/diskOutput.js'
import type { AppState } from './state/AppState.js'
import type { TaskRow } from './rows/vocabulary.js'

const taskKinds = [
  ['local_bash', 'b'],
  ['local_agent', 'a'],
  ['remote_agent', 'r'],
  ['local_workflow', 'w'],
  ['monitor_mcp', 'm'],
] as const
const taskPrefixes = Object.fromEntries(taskKinds)

export type TaskType = (typeof taskKinds)[number][0]
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'

export function generateTaskId(type: TaskType): string {
  const prefix = taskPrefixes[type] ?? 'x'
  let suffix = ''
  for (const byte of randomBytes(TASK_ID_SUFFIX_LENGTH)) {
    suffix += TASK_ID_ALPHABET.charAt(byte % TASK_ID_ALPHABET.length)
  }
  return prefix + suffix
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  switch (status) {
    case 'completed':
    case 'failed':
    case 'killed':
      return true
    default:
      return false
  }
}

type TaskStart = Pick<TaskRow, 'task_id' | 'call_id'> & { task_type: TaskType; description: string }
type TaskProgress = Record<'startTime' | 'outputOffset', number> &
  Partial<Record<'endTime' | 'totalPausedMs', number>> & { outputFile: string; notified: boolean }
export type TaskStateBase = TaskProgress & {
  id: string
  type: TaskType
  status: TaskStatus
  description: string
  toolUseId?: string
}

function beginTaskProgress(id: string): TaskProgress {
  const startTime = Date.now()
  const outputFile = getTaskOutputPath(id)
  return { startTime, outputFile, outputOffset: 0, notified: false }
}

export function createTaskStateBase({ task_id, task_type, description, call_id }: TaskStart): TaskStateBase {
  const identity = { id: task_id, type: task_type, status: 'pending' as TaskStatus, description, toolUseId: call_id }
  return Object.assign(identity, beginTaskProgress(task_id))
}

export type SetAppState = (updater: (prevState: AppState) => AppState) => void
export type TaskContext = { abortController: AbortController; getAppState: () => AppState; setAppState: SetAppState }
export type TaskHandle = { taskId: string; cleanup?: () => void; accepted?: boolean }
export type Task = { name: string; type: TaskType; kill: (taskId: string, setAppState: SetAppState) => unknown }

export type LocalShellSpawnInput = {
  command: string
  description: string
  timeout?: number
  toolUseId?: string
  agentId?: string
  kind?: 'bash' | 'monitor'
  persistent?: boolean
}

export type TaskKillReceipt = { settled: boolean } & Partial<
  Record<'exitCode' | 'processesEnded' | 'processSurvivors', number> &
  { interrupted: boolean; reason: string }
>
