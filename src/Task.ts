import { randomBytes } from 'node:crypto'

import type { AppState } from './state/AppState.js'
import type { TaskRow } from './rows/vocabulary.js'
import { TASK_ID_ALPHABET, TASK_ID_SUFFIX_LENGTH } from './types/ids.js'
import { getTaskOutputPath } from './utils/task/diskOutput.js'

export type TaskType =
  | 'local_bash'
  | 'local_agent'
  | 'remote_agent'
  | 'local_workflow'
  | 'monitor_mcp'

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'

const SETTLED_STATUSES: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'killed'])

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return SETTLED_STATUSES.has(status)
}

export type SetAppState = (updater: (prevState: AppState) => AppState) => void

export type TaskContext = {
  abortController: AbortController
  getAppState: () => AppState
  setAppState: SetAppState
}

export type TaskHandle = { taskId: string; cleanup?: () => void; accepted?: boolean }

export type Task = {
  name: string
  type: TaskType
  kill: (taskId: string, setAppState: SetAppState) => unknown
}

type TaskIdentity = { id: string; type: TaskType; status: TaskStatus; description: string; toolUseId?: string }
type TaskClock = { startTime: number; endTime?: number; totalPausedMs?: number }
type TaskOutput = { outputFile: string; outputOffset: number; notified: boolean }
export type TaskStateBase = TaskIdentity & TaskClock & TaskOutput

export type LocalShellSpawnInput = {
  command: string
  description: string
  timeout?: number
  toolUseId?: string
  agentId?: string
  kind?: 'bash' | 'monitor'
}

export type TaskKillReceipt = { settled: boolean } & Partial<{
  exitCode: number
  interrupted: boolean
  reason: string
  processesEnded: number
  processSurvivors: number
}>

const KIND_LETTER: Record<TaskType, string> = {
  local_bash: 'b',
  local_agent: 'a',
  remote_agent: 'r',
  local_workflow: 'w',
  monitor_mcp: 'm',
}

const randomSymbols = (count: number): string =>
  Array.from(randomBytes(count), byte => TASK_ID_ALPHABET[byte % TASK_ID_ALPHABET.length]).join('')

export function generateTaskId(type: TaskType): string {
  return (KIND_LETTER[type] ?? 'x') + randomSymbols(TASK_ID_SUFFIX_LENGTH)
}

type TaskStart = Pick<TaskRow, 'task_id' | 'call_id'> & { task_type: TaskType; description: string }

export function createTaskStateBase({ task_id, task_type, description, call_id }: TaskStart): TaskStateBase {
  return {
    id: task_id,
    type: task_type,
    status: 'pending',
    description,
    toolUseId: call_id,
    startTime: Date.now(),
    outputFile: getTaskOutputPath(task_id),
    outputOffset: 0,
    notified: false,
  }
}
