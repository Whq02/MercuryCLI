import { randomBytes } from 'node:crypto'

import type { AppState } from './state/AppState.js'
import { getTaskOutputPath } from './utils/task/diskOutput.js'


export type TaskType =
  | 'local_bash'
  | 'local_agent'
  | 'remote_agent'
  | 'in_process_teammate'
  | 'local_workflow'
  | 'monitor_mcp'
  | 'dream'

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

export type SetAppState = (updater: (prevState: AppState) => AppState) => void

export type TaskHandle = {
  taskId: string
  cleanup?: () => void
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
  in_process_teammate: 't',
  local_workflow: 'w',
  monitor_mcp: 'm',
  dream: 'd',
}

const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

export function generateTaskId(type: TaskType): string {
  const prefix = TASK_ID_PREFIXES[type] ?? 'x'
  const bytes = randomBytes(8)
  let suffix = ''
  for (const byte of bytes) {
    suffix += TASK_ID_ALPHABET[byte % TASK_ID_ALPHABET.length]
  }
  return prefix + suffix
}

export function createTaskStateBase(
  id: string,
  type: TaskType,
  description: string,
  toolUseId?: string,
): TaskStateBase {
  return {
    id,
    type,
    status: 'pending',
    description,
    toolUseId,
    startTime: Date.now(),
    outputFile: getTaskOutputPath(id),
    outputOffset: 0,
    notified: false,
  }
}
