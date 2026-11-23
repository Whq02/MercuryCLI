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
import { asAgentId } from '../../types/ids.js'
import type { BashTaskKind, LocalShellTaskState, ShellKillSource } from './guards.js'
import { isLocalShellTask } from './guards.js'
import { killTask } from './killShellTasks.js'
import { passedOver } from '../../utils/passedOver.js'
import { pollUntil } from '../../utils/deadline.js'


export const BACKGROUND_BASH_SUMMARY_PREFIX = 'Background command '

const WATCHDOG_POLL_INTERVAL_MS = 5000
const WATCHDOG_STALL_THRESHOLD_MS = 45_000
const WATCHDOG_TAIL_BYTES = 1024


export function keepTagClosed(text: string, tag: string): string {
  return text.split(`</${tag}>`).join(`<\\/${tag}>`)
}

export function shellNotificationText(facts: { taskId: string; toolUseId: string | undefined; command: string; outputPath: string; status: string; summary: string }): string {
  const lines = [
    `<${TASK_NOTIFICATION_TAG}>`,
    `<${TASK_ID_TAG}>${facts.taskId}</${TASK_ID_TAG}>`,
  ]
  if (facts.toolUseId) {
    lines.push(`<${TOOL_USE_ID_TAG}>${facts.toolUseId}</${TOOL_USE_ID_TAG}>`)
  }
  lines.push(
    `<command>${keepTagClosed(facts.command, 'command')}</command>`,
    `<${OUTPUT_FILE_TAG}>${facts.outputPath}</${OUTPUT_FILE_TAG}>`,
    `<${STATUS_TAG}>${facts.status}</${STATUS_TAG}>`,
    `<${SUMMARY_TAG}>${keepTagClosed(facts.summary, SUMMARY_TAG)}</${SUMMARY_TAG}>`,
    `</${TASK_NOTIFICATION_TAG}>`,
  )
  return lines.join('\n')
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
  let shouldNotify = false
  updateTaskState<LocalShellTaskState>(taskId, setAppState, task => {
    if (task.notified) return task
    shouldNotify = true
    return { ...task, notified: true }
  })
  if (!shouldNotify) return

  const exitDetail = exitCode !== undefined ? ` (exit code ${exitCode})` : ''
  const summary =
    status === 'completed'
      ? `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" completed${exitDetail}`
      : status === 'failed'
        ? `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" ended${exitDetail}`
        : `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" was stopped`

  const value = shellNotificationText({
    taskId,
    toolUseId,
    command,
    outputPath: getTaskOutputPath(taskId),
    status,
    summary,
  })

  abortSpeculation(setAppState)
  enqueuePendingNotification({
    value,
    mode: 'task-notification',
    priority: 'next',
    agentId,
  })
}

function looksLikeInteractivePrompt(tail: string): boolean {
  const trimmedEnd = tail.trimEnd()
  const lastNewline = trimmedEnd.lastIndexOf('\n')
  const lastLine = (lastNewline === -1 ? trimmedEnd : trimmedEnd.slice(lastNewline + 1)).trim()
  if (lastLine === '') return false
  const lower = lastLine.toLowerCase()
  if (
    lower.includes('(y/n)') ||
    lower.includes('[y/n]') ||
    lower.includes('(yes/no)') ||
    lower.includes('press any key') ||
    lower.includes('press enter') ||
    lower.includes('continue?') ||
    lower.includes('overwrite?')
  ) {
    return true
  }
  return /^(?:do you|would you|shall i|are you sure|ready to)\b.*\?$/i.test(lastLine)
}

function armStallWatchdog(args: {
  taskId: string
  description: string
  toolUseId: string | undefined
  agentId: string | undefined
}): () => void {
  const outputPath = getTaskOutputPath(args.taskId)
  const controller = new AbortController()
  let highWaterSize = 0
  let quietSince = Date.now()

  void pollUntil(
    async () => {
      try {
        const stats = await fs.promises.stat(outputPath)
        if (stats.size > highWaterSize) {
          highWaterSize = stats.size
          quietSince = Date.now()
          return undefined
        }
      } catch (error) {
        passedOver(error)
      }

      if (controller.signal.aborted) return true
      if (Date.now() - quietSince < WATCHDOG_STALL_THRESHOLD_MS) return undefined

      let tail: string
      try {
        tail = (await tailFile(outputPath, WATCHDOG_TAIL_BYTES)).content
      } catch (error) {
        passedOver(error)
        return undefined
      }

      if (controller.signal.aborted) return true

      if (!looksLikeInteractivePrompt(tail)) {
        quietSince = Date.now()
        return undefined
      }

      const summary = [
        `${BACKGROUND_BASH_SUMMARY_PREFIX}"${args.description}" seems to be blocked waiting for keyboard input. Last output:`,
        tail.trimEnd(),
        'To proceed: stop the task, then launch the command again with its answers piped into standard input, or with whatever non-interactive option it offers.',
      ].join('\n')

      const lines = [
        `<${TASK_NOTIFICATION_TAG}>`,
        `<${TASK_ID_TAG}>${args.taskId}</${TASK_ID_TAG}>`,
      ]
      if (args.toolUseId) {
        lines.push(`<${TOOL_USE_ID_TAG}>${args.toolUseId}</${TOOL_USE_ID_TAG}>`)
      }
      lines.push(
        `<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>`,
        `<${SUMMARY_TAG}>${keepTagClosed(summary, SUMMARY_TAG)}</${SUMMARY_TAG}>`,
        `</${TASK_NOTIFICATION_TAG}>`,
      )

      enqueuePendingNotification({
        value: lines.join('\n'),
        mode: 'task-notification',
        priority: 'next',
        agentId: args.agentId,
      })
      return true
    },
    WATCHDOG_POLL_INTERVAL_MS,
    Number.POSITIVE_INFINITY,
    () => undefined,
    { signal: controller.signal, onAbort: () => undefined, unref: true },
  ).catch(passedOver)

  return () => {
    controller.abort()
  }
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
  const { shellCommand } = input
  const taskId = shellCommand.taskOutput.taskId
  const { setAppState } = context
  const unregisterCleanup = registerCleanup(async () => {
    await killTask(taskId, setAppState)
  })
  const base = createTaskStateBase({
    task_id: taskId,
    task_type: 'local_bash',
    description: input.description,
    call_id: input.toolUseId,
  })
  const startTime = input.startTime !== undefined ? input.startTime : base.startTime
  const verifyCwd = getCwd()
  const taskState: LocalShellTaskState = {
    ...base,
    startTime,
    type: 'local_bash',
    status: 'running',
    command: input.command,
    shellCommand,
    unregisterCleanup,
    completionStatusSentInAttachment: false,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
    agentId: input.agentId !== undefined ? asAgentId(input.agentId) : undefined,
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    verifyCwd,
  }
  registerTask(taskState, setAppState)

  const accepted = shellCommand.background(taskId)
  if (!accepted) {
    let result: { stdout: string; stderr: string; code: number; interrupted: boolean }
    try {
      result = await shellCommand.result
    } catch (error) {
      logError(error)
      result = { stdout: '', stderr: '', code: 1, interrupted: false }
    }
    let capturedStart = startTime
    let capturedCwd: string | undefined = verifyCwd
    const endTime = Date.now()
    updateTaskState<LocalShellTaskState>(taskId, setAppState, task => {
      capturedStart = task.startTime
      capturedCwd = task.verifyCwd
      return {
        ...task,
        status: result.code === 0 ? 'completed' : 'failed',
        result: { code: result.code, interrupted: result.interrupted },
        notified: true,
        shellCommand: null,
        unregisterCleanup: undefined,
        endTime,
      }
    })
    const outcome = shellOutcomeState({
      code: result.code,
      interrupted: result.interrupted,
      wasKilled: false,
      stderr: result.stderr,
    })
    void recordTaskOutcome(getSessionId(), {
      taskId,
      taskType: 'local_bash',
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      command: input.command,
      description: input.description,
      spawn: 'confirmed',
      state: outcome.state,
      ...(outcome.terminationReason !== undefined
        ? { terminationReason: outcome.terminationReason }
        : {}),
      exitCode: result.code,
      interrupted: result.interrupted,
      startTime: capturedStart,
      endTime,
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(capturedCwd !== undefined ? { cwd: capturedCwd } : {}),
      output: { artifactPath: artifactPathFor(taskId, input.toolUseId) },
    })
    unregisterCleanup()
    return {
      taskId,
      cleanup: () => {},
      accepted: false,
    }
  }

  const cancelWatchdog =
    input.kind === 'monitor'
      ? undefined
      : armStallWatchdog({
          taskId,
          description: input.description,
          toolUseId: input.toolUseId,
          agentId: input.agentId,
        })
  void recordTaskLaunch(getSessionId(), {
    taskId,
    kind: input.kind === 'monitor' ? 'monitor' : 'shell',
    toolUseId: input.toolUseId ?? '',
    description: input.description,
    command: input.command,
    persistent: input.persistent === true,
    outputPath: input.kind === 'monitor' ? null : getTaskOutputPath(taskId),
    pid: typeof shellCommand.pid === 'number' ? shellCommand.pid : null,
    armedAt: startTime,
  })
  void settleShellTask({
    taskId,
    shellCommand,
    setAppState,
    cancelWatchdog,
    launch: {
      command: input.command,
      description: input.description,
      agentId: input.agentId,
      cwd: verifyCwd,
      startTime,
      toolUseId: input.toolUseId,
      kind: input.kind,
    },
    runCleanupAfterUpdate: false,
  })
  return {
    taskId,
    cleanup: unregisterCleanup,
    accepted: true,
  }
}

export function registerForeground(
  input: LocalShellSpawnInput & { shellCommand: ShellCommand },
  setAppState: SetAppState,
  toolUseId?: string,
): string {
  const { shellCommand } = input
  const taskId = shellCommand.taskOutput.taskId
  const resolvedToolUseId = toolUseId ?? input.toolUseId
  const unregisterCleanup = registerCleanup(async () => {
    await killTask(taskId, setAppState)
  })
  const base = createTaskStateBase({
    task_id: taskId,
    task_type: 'local_bash',
    description: input.description,
    call_id: resolvedToolUseId,
  })
  const taskState: LocalShellTaskState = {
    ...base,
    type: 'local_bash',
    status: 'running',
    command: input.command,
    shellCommand,
    unregisterCleanup,
    completionStatusSentInAttachment: false,
    lastReportedTotalLines: 0,
    isBackgrounded: false,
    agentId: input.agentId !== undefined ? asAgentId(input.agentId) : undefined,
    verifyCwd: getCwd(),
  }
  registerTask(taskState, setAppState)
  return taskId
}

export function unregisterForeground(taskId: string, setAppState: SetAppState): void {
  let cleanupToRun: (() => void) | undefined
  setAppState(prev => {
    const task = prev.tasks?.[taskId]
    if (!task || !isLocalShellTask(task) || task.isBackgrounded) return prev
    cleanupToRun = task.unregisterCleanup
    const { [taskId]: _removed, ...rest } = prev.tasks
    return { ...prev, tasks: rest }
  })
  if (cleanupToRun) {
    try {
      cleanupToRun()
    } catch (error) {
      logError(error)
    }
  }
}

export function markTaskNotified(taskId: string, setAppState: SetAppState): void {
  updateTaskState<LocalShellTaskState>(taskId, setAppState, task =>
    task.notified ? task : { ...task, notified: true },
  )
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
  if (!shellCommand.background(taskId)) return false

  updateTaskState<LocalShellTaskState>(taskId, setAppState, current =>
    current.isBackgrounded ? current : { ...current, isBackgrounded: true },
  )

  const cancelWatchdog = armStallWatchdog({
    taskId,
    description,
    toolUseId: toolUseId ?? launch?.toolUseId,
    agentId: undefined,
  })
  void recordTaskLaunch(getSessionId(), {
    taskId,
    kind: launch?.kind === 'monitor' ? 'monitor' : 'shell',
    toolUseId: toolUseId ?? launch?.toolUseId ?? '',
    description,
    command: launch?.command ?? '',
    persistent: false,
    outputPath: getTaskOutputPath(taskId),
    pid: typeof shellCommand.pid === 'number' ? shellCommand.pid : null,
    armedAt: launch?.startTime ?? Date.now(),
  })
  void settleShellTask({
    taskId,
    shellCommand,
    setAppState,
    cancelWatchdog,
    launch,
    runCleanupAfterUpdate: true,
  })
  return true
}

export function backgroundAll(getAppState: () => AppState, setAppState: SetAppState): void {
  const tasks = Object.values(getAppState().tasks ?? {})
  for (const task of tasks) {
    if (isLocalShellTask(task) && !task.isBackgrounded && task.status === 'running') {
      backgroundRegisteredTask(task.id, getAppState, setAppState)
    }
  }
  for (const task of tasks) {
    if (isLocalAgentTask(task) && !task.isBackgrounded && task.status === 'running') {
      backgroundAgentTask(task.id, getAppState, setAppState)
    }
  }
}


export const LocalShellTask: Task = {
  name: 'LocalShellTask',
  type: 'local_bash',
  async kill(taskId: string, setAppState: SetAppState) {
    const settlement = await killTask(taskId, setAppState)
    if (!settlement.settled) {
      logError(
        new Error(
          `shell task ${taskId} did not settle within the kill grace — the process may still be terminating`,
        ),
      )
    }
    logForDebugging(`killed shell task ${taskId}: ${JSON.stringify(settlement)}`)
    return settlement
  },
}
