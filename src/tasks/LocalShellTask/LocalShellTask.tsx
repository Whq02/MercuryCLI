import { existsSync } from 'node:fs'
import * as fs from 'node:fs'

import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'
import type {
  LocalShellSpawnInput,
  SetAppState,
  Task,
  TaskContext,
  TaskHandle,
} from '../../Task.js'
import { createTaskStateBase } from '../../Task.js'
import type { AppState } from '../../state/AppState.js'
import { getSessionId } from '../../bootstrap/state.js'
import { abortSpeculation } from '../../services/PromptSuggestion/speculation.js'
import { processOwnerForLane } from '../../utils/run/resolveOwner.js'
import { recordTaskLaunch, settleTaskLaunch } from '../taskLaunchLedger.js'
import { recordTaskOutcome, shellOutcomeState } from '../taskOutcomeEnvelope.js'
import { backgroundAgentTask, isLocalAgentTask } from '../LocalAgentTask/LocalAgentTask.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import type { ShellCommand } from '../../utils/ShellCommand.js'
import { tailFile } from '../../utils/fsOperations.js'
import {
  acquireTaskOutputWriter,
  evictTaskOutput,
  getTaskOutputPath,
} from '../../utils/task/diskOutput.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'
import { getToolResultPath } from '../../utils/toolResultStorage.js'
import { recordShellCommandOutcome } from '../../utils/verification/verificationState.js'
import type { AgentId } from '../../types/ids.js'
import type { BashTaskKind, LocalShellTaskState, ShellKillSource } from './guards.js'
import { isLocalShellTask } from './guards.js'
import { killTask } from './killShellTasks.js'
import { passedOver } from '../../utils/passedOver.js'
import { pollUntil } from '../../utils/deadline.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'


export const BACKGROUND_BASH_SUMMARY_PREFIX: Unbuilt = unbuilt('src/tasks/LocalShellTask/LocalShellTask.tsx:50')

const WATCHDOG_POLL_INTERVAL_MS = 5000
const WATCHDOG_STALL_THRESHOLD_MS = 45_000
const WATCHDOG_TAIL_BYTES = 1024


export function keepTagClosed(text: string, tag: string): string {
  return text.split(`</${tag}>`).join(`<\\/${tag}>`)
}

export function shellNotificationText(facts: { taskId: string; toolUseId: string | undefined; command: string; outputPath: string; status: string; summary: string }): string {
  return notBuilt('src/tasks/LocalShellTask/LocalShellTask.tsx:77')
}

function enqueueShellNotification(
  taskId: string,
  command: string,
  description: string,
  status: 'completed' | 'failed' | 'stopped',
  exitCode: number | undefined,
  setAppState: SetAppState,
  toolUseId: string | undefined,
  agentId: string | undefined,
  _kind: BashTaskKind | undefined,
): void {
  return notBuilt('src/tasks/LocalShellTask/LocalShellTask.tsx:88')
}


function armStallWatchdog(args: {
  taskId: string
  description: string
  toolUseId: string | undefined
  agentId: string | undefined
}): () => void {
  return notBuilt('src/tasks/LocalShellTask/LocalShellTask.tsx:126')
}


function artifactPathFor(taskId: string, toolUseId: string | undefined): string {
  if (toolUseId) {
    const durable = getToolResultPath(toolUseId, false)
    if (existsSync(durable)) return durable
  }
  return getTaskOutputPath(taskId)
}

export type ShellLaunchFacts = {
  command: string
  description: string
  agentId?: string
  cwd?: string
  startTime: number
  toolUseId?: string
  kind?: BashTaskKind
}

async function settleShellTask(args: {
  taskId: string
  shellCommand: ShellCommand
  setAppState: SetAppState
  cancelWatchdog?: () => void
  launch?: ShellLaunchFacts
  runCleanupAfterUpdate: boolean
}): Promise<void> {
  const { taskId, shellCommand, setAppState } = args
  args.cancelWatchdog?.()

  let result: { stdout: string; stderr: string; code: number; interrupted: boolean; pipelineStatus?: number[] }
  try {
    result = await shellCommand.result
  } catch (error) {
    logError(error)
    result = { stdout: '', stderr: '', code: 1, interrupted: false }
  }

  try {
    await acquireTaskOutputWriter(taskId).flush()
  } catch (error) {
    logError(error)
  }
  try {
    shellCommand.cleanup()
  } catch (error) {
    logError(error)
  }

  let wasKilled = false
  let killedBy: ShellKillSource | undefined
  let wasNotified = false
  let startTime = args.launch?.startTime ?? Date.now()
  let command = args.launch?.command ?? ''
  let description = args.launch?.description ?? ''
  let launchCwd: string | undefined = args.launch?.cwd
  let toolUseId: string | undefined = args.launch?.toolUseId
  let agentId: string | undefined = args.launch?.agentId
  let kind: BashTaskKind | undefined = args.launch?.kind
  let cleanupToRun: (() => void) | undefined
  let transitioned = false

  updateTaskState<LocalShellTaskState>(taskId, setAppState, task => {
    startTime = task.startTime
    command = task.command ?? ''
    description = task.description ?? ''
    launchCwd = task.verifyCwd
    toolUseId = task.toolUseId
    agentId = task.agentId
    kind = task.kind
    if (task.status === 'killed') {
      wasKilled = true
      killedBy = task.killedBy
      return task
    }
    wasNotified = task.notified
    transitioned = true
    cleanupToRun = task.unregisterCleanup
    return {
      ...task,
      status: result.code === 0 ? 'completed' : 'failed',
      result: { code: result.code, interrupted: result.interrupted },
      shellCommand: null,
      unregisterCleanup: undefined,
      endTime: Date.now(),
    }
  })

  if (args.runCleanupAfterUpdate && transitioned) {
    try {
      cleanupToRun?.()
    } catch (error) {
      logError(error)
    }
  }

  if (!wasKilled && !wasNotified && launchCwd) {
    recordShellCommandOutcome(command, result.code, launchCwd, processOwnerForLane(agentId ?? null), result.pipelineStatus, shellCommand.verificationStart)
  }

  const outcome = shellOutcomeState({
    code: result.code,
    interrupted: result.interrupted,
    wasKilled,
    ...(killedBy !== undefined ? { killedBy } : {}),
    stderr: result.stderr,
  })
  void settleTaskLaunch(getSessionId(), taskId)
  void recordTaskOutcome(getSessionId(), {
    taskId,
    taskType: 'local_bash',
    ...(kind !== undefined ? { kind } : {}),
    command,
    ...(description !== '' ? { description } : {}),
    spawn: 'confirmed',
    state: outcome.state,
    ...(outcome.terminationReason !== undefined
      ? { terminationReason: outcome.terminationReason }
      : {}),
    exitCode: result.code,
    interrupted: result.interrupted,
    startTime,
    endTime: Date.now(),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(launchCwd !== undefined ? { cwd: launchCwd } : {}),
    output: { artifactPath: artifactPathFor(taskId, toolUseId) },
  })

  enqueueShellNotification(
    taskId,
    command,
    description,
    wasKilled ? 'stopped' : result.code === 0 ? 'completed' : 'failed',
    wasKilled ? undefined : result.code,
    setAppState,
    toolUseId,
    agentId,
    kind,
  )

  void evictTaskOutput(taskId)
}


export async function spawnShellTask(
  input: LocalShellSpawnInput & { shellCommand: ShellCommand; startTime?: number },
  context: TaskContext,
): Promise<TaskHandle> {
  return notBuilt('src/tasks/LocalShellTask/LocalShellTask.tsx:344')
}

export function registerForeground(
  input: LocalShellSpawnInput & { shellCommand: ShellCommand },
  setAppState: SetAppState,
  toolUseId?: string,
): string {
  return notBuilt('src/tasks/LocalShellTask/LocalShellTask.tsx:469')
}

export function unregisterForeground(taskId: string, setAppState: SetAppState): void {
  return notBuilt('src/tasks/LocalShellTask/LocalShellTask.tsx:496')
}

export function markTaskNotified(taskId: string, setAppState: SetAppState): void {
  return notBuilt('src/tasks/LocalShellTask/LocalShellTask.tsx:514')
}

function backgroundRegisteredTask(
  taskId: string,
  getAppState: () => AppState,
  setAppState: SetAppState,
): boolean {
  const task = getAppState().tasks?.[taskId]
  if (!task || !isLocalShellTask(task)) return false
  if (task.isBackgrounded) return false
  if (task.status !== 'running') return false
  const shellCommand = task.shellCommand
  if (!shellCommand) return false
  if (!shellCommand.background(taskId)) return false

  updateTaskState<LocalShellTaskState>(taskId, setAppState, current => ({
    ...current,
    isBackgrounded: true,
  }))

  const cancelWatchdog =
    task.kind === 'monitor'
      ? undefined
      : armStallWatchdog({
          taskId,
          description: task.description,
          toolUseId: task.toolUseId,
          agentId: task.agentId,
        })
  void recordTaskLaunch(getSessionId(), {
    taskId,
    kind: task.kind === 'monitor' ? 'monitor' : 'shell',
    toolUseId: task.toolUseId ?? '',
    description: task.description ?? '',
    command: task.command ?? '',
    persistent: false,
    outputPath: getTaskOutputPath(taskId),
    pid: typeof shellCommand.pid === 'number' ? shellCommand.pid : null,
    armedAt: task.startTime,
  })
  void settleShellTask({
    taskId,
    shellCommand,
    setAppState,
    cancelWatchdog,
    runCleanupAfterUpdate: true,
  })
  return true
}

export function backgroundExistingForegroundTask(
  taskId: string,
  shellCommand: ShellCommand,
  description: string,
  setAppState: SetAppState,
  toolUseId?: string,
  launch?: ShellLaunchFacts,
): boolean {
  return notBuilt('src/tasks/LocalShellTask/LocalShellTask.tsx:568')
}

export function backgroundAll(getAppState: () => AppState, setAppState: SetAppState): void {
  return notBuilt('src/tasks/LocalShellTask/LocalShellTask.tsx:610')
}


export const LocalShellTask: Task = unbuilt('src/tasks/LocalShellTask/LocalShellTask.tsx:625')
