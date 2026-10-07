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

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

export type SetAppState = (updater: (prevState: AppState) => AppState) => void

export type TaskHandle = {
  taskId: string
  cleanup?: () => void
  accepted?: boolean
}

export type TaskContext = {
  abortController: AbortController
  getAppState: () => AppState
  setAppState: SetAppState
}

export type TaskStateBase = {
  id: string
  type: TaskType
  status: TaskStatus
  description: string
  toolUseId?: string
  startTime: number
  endTime?: number
  totalPausedMs?: number
  outputFile: string
  outputOffset: number
  notified: boolean
}

export type LocalShellSpawnInput = {
  command: string
  description: string
  timeout?: number
  toolUseId?: string
  agentId?: string
  kind?: 'bash' | 'monitor'
}

export type TaskKillReceipt = {
  settled: boolean
  exitCode?: number
  interrupted?: boolean
  reason?: string
  processesEnded?: number
  processSurvivors?: number
}

export type Task = {
  name: string
  type: TaskType
  kill: (taskId: string, setAppState: SetAppState) => unknown
}

const TASK_ID_PREFIXES: Record<TaskType, string> = {
  local_bash: 'b',
  local_agent: 'a',
  remote_agent: 'r',
  local_workflow: 'w',
  monitor_mcp: 'm',
}

export function generateTaskId(type: TaskType): string {
  const prefix = TASK_ID_PREFIXES[type] ?? 'x'
  const bytes = randomBytes(TASK_ID_SUFFIX_LENGTH)
  let suffix = ''
  for (const byte of bytes) {
    suffix += TASK_ID_ALPHABET[byte % TASK_ID_ALPHABET.length]
  }
  return prefix + suffix
}

export type TaskStart = Pick<TaskRow, 'task_id' | 'call_id'> & { task_type: TaskType; description: string }

export function createTaskStateBase(start: TaskStart): TaskStateBase {
  return {
    id: start.task_id,
    type: start.task_type,
    status: 'pending',
    description: start.description,
    toolUseId: start.call_id,
    startTime: Date.now(),
    outputFile: getTaskOutputPath(start.task_id),
    outputOffset: 0,
    notified: false,
  }
}
