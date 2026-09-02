import { randomBytes } from 'node:crypto'

import type { AppState } from './state/AppState.js'
import { getTaskOutputPath } from './utils/task/diskOutput.js'

/**
 * The background-task model: the closed kind and status vocabularies, the
 * shared state base every task extends, id minting, and the polymorphic kill
 * interface with its settlement receipt.
 *
 * The kind and status strings are wire/persistence contract data — they
 * appear in persisted session state, task notifications, and SDK events.
 */

/** The closed set of task kinds (contract data — persisted + wire-visible). */
export type TaskType =
  | 'local_bash'
  | 'local_agent'
  | 'remote_agent'
  | 'in_process_teammate'
  | 'local_workflow'
  | 'monitor_mcp'
  | 'dream'

/** The closed set of task statuses (contract data — persisted + wire-visible). */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'

/**
 * Terminal = finished for good. Guards message injection into dead
 * teammates, task eviction, and orphan cleanup.
 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

/** The app-state writer every task mutation goes through. */
export type SetAppState = (updater: (prevState: AppState) => AppState) => void

/** What a spawn returns: the task id plus an optional cleanup releaser. */
export type TaskHandle = {
  taskId: string
  cleanup?: () => void
}

/** The state plumbing handed to task operations. */
export type TaskContext = {
  abortController: AbortController
  getAppState: () => AppState
  setAppState: SetAppState
}

/**
 * The fields every task state shares. Concrete task states extend this with
 * their own kind discriminant and payload.
 */
export type TaskStateBase = {
  id: string
  type: TaskType
  status: TaskStatus
  /** Human description shown in notifications and the task UI. */
  description: string
  /** The tool_use id that spawned this task, when a tool did. */
  toolUseId?: string
  startTime: number
  endTime?: number
  /** Total milliseconds this task spent paused, when the kind supports pause. */
  totalPausedMs?: number
  /** Where this task's output lives on disk. */
  outputFile: string
  /** How much of the output file has already been consumed by attachments. */
  outputOffset: number
  /** Whether the terminal notification for this task has been sent. */
  notified: boolean
}

/** The input shape both shell tools hand to the shell-task layer. */
export type LocalShellSpawnInput = {
  command: string
  description: string
  timeout?: number
  toolUseId?: string
  /** The spawning agent's id; absent = the main thread. */
  agentId?: string
  /** UI display variant (contract data): a plain shell or a monitor. */
  kind?: 'bash' | 'monitor'
}

/**
 * A kill settlement receipt: asking a process to stop and knowing that it
 * stopped are different facts, and callers are entitled to know which one
 * they have.
 */
export type TaskKillReceipt = {
  settled: boolean
  exitCode?: number
  /** The stop's provenance: true when Mercury's own stop ended the process
   *  (the fact the shell result's `interrupted` carries), on every platform.
   *  Consumers switch on THIS, never on the number — the exit code stays
   *  platform-honest (POSIX reports the kill signal as 137; win32 reports
   *  the code cmd.exe settles on under taskkill /F, 1). */
  interrupted?: boolean
  reason?: string
  /** How many processes the stop ended — the whole tree, not just the
   *  leader; present when the kill path counted its sweep. */
  processesEnded?: number
  /** Pids still alive when the bounded reap expired; present and nonzero
   *  only when the sweep could not confirm a clean end. */
  processSurvivors?: number
}

/**
 * A task implementation. Only `kill` is dispatched polymorphically — spawn
 * and render never were. The return type is deliberately permissive: an
 * implementation may return nothing, or a settlement receipt, and the stop
 * path surfaces whichever it got rather than discarding it.
 */
export type Task = {
  name: string
  type: TaskType
  kill: (taskId: string, setAppState: SetAppState) => unknown
}

/**
 * One-character kind prefixes (contract data — they appear in persisted
 * state and user-visible ids). Unknown kinds fall back to 'x'.
 */
const TASK_ID_PREFIXES: Record<TaskType, string> = {
  local_bash: 'b',
  local_agent: 'a',
  remote_agent: 'r',
  in_process_teammate: 't',
  local_workflow: 'w',
  monitor_mcp: 'm',
  dream: 'd',
}

/**
 * The 36-symbol id alphabet: digits then lowercase letters, safe under
 * case-insensitive filesystems. Eight symbols give ~2.8e12 combinations —
 * the id space (not the distribution) is the defence against an attacker
 * pre-planting a symlink at a task's output path.
 */
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/**
 * Mint a task id: the kind prefix followed by eight cryptographically random
 * symbols. Each random byte is reduced modulo the alphabet length — very
 * slightly non-uniform, and deliberately left that way (nothing depends on
 * perfect uniformity; there is no rejection sampling). There is no
 * uniqueness check against live tasks: the output-file layer detects a
 * collision instead.
 */
export function generateTaskId(type: TaskType): string {
  const prefix = TASK_ID_PREFIXES[type] ?? 'x'
  const bytes = randomBytes(8)
  let suffix = ''
  for (const byte of bytes) {
    suffix += TASK_ID_ALPHABET[byte % TASK_ID_ALPHABET.length]
  }
  return prefix + suffix
}

/**
 * Mint the shared state base: pending, started now, output at the task's
 * output path, nothing consumed, not notified. Callers that start work
 * immediately overwrite the status to running on the object they register —
 * this factory never mints a running task.
 */
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
