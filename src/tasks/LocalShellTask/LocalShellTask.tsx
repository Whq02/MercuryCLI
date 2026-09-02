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
import { processOwnerForLane } from '../../services/run/resolveOwner.js'
import { recordTaskOutcome, shellOutcomeState } from '../taskOutcomeEnvelope.js'
import { isMainSessionTask } from '../LocalMainSessionTask.js'
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
import { escapeXml } from '../../utils/xml.js'
import type { AgentId } from '../../types/ids.js'
import type { BashTaskKind, LocalShellTaskState } from './guards.js'
import { isLocalShellTask } from './guards.js'
import { killTask } from './killShellTasks.js'


export const BACKGROUND_BASH_SUMMARY_PREFIX = 'Background command '

const WATCHDOG_POLL_INTERVAL_MS = 5000
const WATCHDOG_STALL_THRESHOLD_MS = 45_000
const WATCHDOG_TAIL_BYTES = 1024

export function looksLikePrompt(tail: string): boolean {
  const lines = tail.trimEnd().split('\n')
  const lastLine = (lines[lines.length - 1] ?? '').trim()
  if (lastLine === '') return false
  const lower = lastLine.toLowerCase()
  if (lower.includes('(y/n)') || lower.includes('[y/n]') || lower.includes('(yes/no)')) {
    return true
  }
  if (/^(do you|would you|shall i|are you sure|ready to)\b.*\?$/i.test(lastLine)) {
    return true
  }
  if (lower.includes('press any key') || lower.includes('press enter')) return true
  if (lower.includes('continue?') || lower.includes('overwrite?')) return true
  return false
}


let assistantModeActive = false

export function setAssistantModeActive(on: boolean): void {
  assistantModeActive = on
}

export function isAssistantModeActive(): boolean {
  return assistantModeActive
}


export type ForegroundBudgetHandle = {
  disarm: () => void
  readonly fired: boolean
}

export function armForegroundBudget(args: {
  budgetMs: number
  enabled: boolean
  resultPromise: Promise<unknown>
  signal?: AbortSignal
  onBudgetExceeded: () => void
}): ForegroundBudgetHandle {
  if (!args.enabled) {
    return { disarm: () => {}, fired: false }
  }
  let fired = false
  let disarmed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  const disarm = (): void => {
    disarmed = true
    clear()
  }
  timer = setTimeout(() => {
    if (disarmed || fired) return
    fired = true
    clear()
    try {
      args.onBudgetExceeded()
    } catch (error) {
      logError(error)
    }
  }, args.budgetMs)
  timer.unref?.()
  args.resultPromise.then(disarm, disarm)
  args.signal?.addEventListener('abort', disarm, { once: true })
  return {
    disarm,
    get fired(): boolean {
      return fired
    },
  }
}


function enqueueShellNotification(
  taskId: string,
  description: string,
  status: 'completed' | 'failed' | 'stopped',
  exitCode: number | undefined,
  setAppState: SetAppState,
  toolUseId: string | undefined,
  agentId: string | undefined,
  _kind: BashTaskKind | undefined,
): void {
  let shouldEnqueue = false
  updateTaskState<LocalShellTaskState>(taskId, setAppState, task => {
    if (task.notified) return task
    shouldEnqueue = true
    return { ...task, notified: true }
  })
  if (!shouldEnqueue) return

  abortSpeculation(setAppState)

  const codePart = exitCode !== undefined ? ` (exit code ${exitCode})` : ''
  const summary =
    status === 'completed'
      ? `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" completed${codePart}`
      : status === 'failed'
        ? `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" failed${codePart}`
        : `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" was stopped`

  const toolUseIdLine = toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${getTaskOutputPath(taskId)}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${escapeXml(summary)}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`

  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
    priority: 'later',
    agentId: agentId as AgentId | undefined,
  })
}


function armStallWatchdog(args: {
  taskId: string
  description: string
  toolUseId: string | undefined
  agentId: string | undefined
}): () => void {
  const outputPath = getTaskOutputPath(args.taskId)
  let latched = false
  let lastSize = 0
  let lastGrowthAt = Date.now()
  let checking = false

  const timer = setInterval(() => {
    if (latched || checking) return
    checking = true
    void (async () => {
      try {
        let size = lastSize
        try {
          size = (await fs.promises.stat(outputPath)).size
        } catch {
          return
        }
        if (size > lastSize) {
          lastSize = size
          lastGrowthAt = Date.now()
          return
        }
        if (Date.now() - lastGrowthAt < WATCHDOG_STALL_THRESHOLD_MS) return
        let tail: { content: string }
        try {
          tail = await tailFile(outputPath, WATCHDOG_TAIL_BYTES)
        } catch {
          return
        }
        if (!looksLikePrompt(tail.content)) {
          lastGrowthAt = Date.now()
          return
        }
        if (latched) return
        latched = true
        clearInterval(timer)
        const lastOutput = tail.content.trimEnd()
        const summary =
          `${BACKGROUND_BASH_SUMMARY_PREFIX}"${args.description}" seems to be blocked ` +
          `waiting for keyboard input`
        const toolUseIdLine = args.toolUseId
          ? `\n<${TOOL_USE_ID_TAG}>${args.toolUseId}</${TOOL_USE_ID_TAG}>`
          : ''
        const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${args.taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${SUMMARY_TAG}>${escapeXml(
          `${summary}. Last output:\n${lastOutput}\n` +
            `To proceed: stop the task, then launch the command again with its answers ` +
            `piped into standard input, or with whatever non-interactive option it offers.`,
        )}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`
        enqueuePendingNotification({
          value: message,
          mode: 'task-notification',
          priority: 'next',
          agentId: args.agentId as AgentId | undefined,
        })
      } finally {
        checking = false
      }
    })()
  }, WATCHDOG_POLL_INTERVAL_MS)
  timer.unref?.()

  return () => {
    latched = true
    clearInterval(timer)
  }
}


function artifactPathFor(taskId: string, toolUseId: string | undefined): string {
  if (toolUseId) {
    const durable = getToolResultPath(toolUseId, false)
    if (existsSync(durable)) return durable
  }
  return getTaskOutputPath(taskId)
}

async function settleShellTask(args: {
  taskId: string
  shellCommand: ShellCommand
  setAppState: SetAppState
  cancelWatchdog?: () => void
  runCleanupAfterUpdate: boolean
}): Promise<void> {
  const { taskId, shellCommand, setAppState } = args
  args.cancelWatchdog?.()

  let result: { stdout: string; stderr: string; code: number; interrupted: boolean }
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
  let wasNotified = false
  let startTime = Date.now()
  let command = ''
  let description = ''
  let launchCwd: string | undefined
  let toolUseId: string | undefined
  let agentId: string | undefined
  let kind: BashTaskKind | undefined
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
    recordShellCommandOutcome(command, result.code, launchCwd, processOwnerForLane(agentId ?? null))
  }

  const outcome = shellOutcomeState({
    code: result.code,
    interrupted: result.interrupted,
    wasKilled,
    stderr: result.stderr,
  })
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
  input: LocalShellSpawnInput & { shellCommand: ShellCommand },
  context: TaskContext,
): Promise<TaskHandle> {
  const { shellCommand } = input
  const setAppState = context.setAppState
  const taskId = shellCommand.taskOutput.taskId

  const unregister = registerCleanup(async () => {
    await killTask(taskId, setAppState)
  })

  const state: LocalShellTaskState = {
    ...createTaskStateBase(taskId, 'local_bash', input.description, input.toolUseId),
    type: 'local_bash',
    status: 'running',
    command: input.command,
    shellCommand,
    unregisterCleanup: unregister,
    completionStatusSentInAttachment: false,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
    agentId: input.agentId as AgentId | undefined,
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    verifyCwd: getCwd(),
  }
  registerTask(state, setAppState)

  const accepted = shellCommand.background(taskId)
  if (!accepted) {
    let result: { stdout: string; stderr: string; code: number; interrupted: boolean }
    try {
      result = await shellCommand.result
    } catch (error) {
      logError(error)
      result = { stdout: '', stderr: '', code: 1, interrupted: false }
    }
    let startTime = Date.now()
    let launchCwd: string | undefined
    updateTaskState<LocalShellTaskState>(taskId, setAppState, task => {
      startTime = task.startTime
      launchCwd = task.verifyCwd
      return {
        ...task,
        status: result.code === 0 ? 'completed' : 'failed',
        result: { code: result.code, interrupted: result.interrupted },
        notified: true,
        shellCommand: null,
        unregisterCleanup: undefined,
        endTime: Date.now(),
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
      startTime,
      endTime: Date.now(),
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(launchCwd !== undefined ? { cwd: launchCwd } : {}),
      output: { artifactPath: artifactPathFor(taskId, input.toolUseId) },
    })
    unregister()
    return { taskId, cleanup: () => {} }
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

  void settleShellTask({
    taskId,
    shellCommand,
    setAppState,
    cancelWatchdog,
    runCleanupAfterUpdate: false,
  })

  return { taskId, cleanup: unregister }
}

export function registerForeground(
  input: LocalShellSpawnInput & { shellCommand: ShellCommand },
  setAppState: SetAppState,
  toolUseId?: string,
): string {
  const { shellCommand } = input
  const taskId = shellCommand.taskOutput.taskId
  const unregister = registerCleanup(async () => {
    await killTask(taskId, setAppState)
  })
  const state: LocalShellTaskState = {
    ...createTaskStateBase(
      taskId,
      'local_bash',
      input.description,
      toolUseId ?? input.toolUseId,
    ),
    type: 'local_bash',
    status: 'running',
    command: input.command,
    shellCommand,
    unregisterCleanup: unregister,
    completionStatusSentInAttachment: false,
    lastReportedTotalLines: 0,
    isBackgrounded: false,
    agentId: input.agentId as AgentId | undefined,
    verifyCwd: getCwd(),
  }
  registerTask(state, setAppState)
  return taskId
}

export function unregisterForeground(taskId: string, setAppState: SetAppState): void {
  let cleanupToRun: (() => void) | undefined
  setAppState(prevState => {
    const task = prevState.tasks?.[taskId]
    if (!task || !isLocalShellTask(task)) return prevState
    if (task.isBackgrounded) return prevState
    cleanupToRun = task.unregisterCleanup
    const tasks = { ...prevState.tasks }
    delete tasks[taskId]
    return { ...prevState, tasks }
  })
  try {
    cleanupToRun?.()
  } catch (error) {
    logError(error)
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
): boolean {
  if (!shellCommand.background(taskId)) return false

  updateTaskState<LocalShellTaskState>(taskId, setAppState, task =>
    task.isBackgrounded ? task : { ...task, isBackgrounded: true },
  )

  const cancelWatchdog = armStallWatchdog({
    taskId,
    description,
    toolUseId,
    agentId: undefined,
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

export function hasForegroundTasks(state: AppState): boolean {
  for (const task of Object.values(state.tasks ?? {})) {
    if (isMainSessionTask(task)) continue
    if ('isBackgrounded' in task && task.isBackgrounded === false && task.status === 'running') {
      return true
    }
  }
  return false
}

export function backgroundAll(getAppState: () => AppState, setAppState: SetAppState): void {
  const tasks = Object.values(getAppState().tasks ?? {})
  for (const task of tasks) {
    if (!isLocalShellTask(task)) continue
    if (task.isBackgrounded || task.status !== 'running') continue
    backgroundRegisteredTask(task.id, getAppState, setAppState)
  }
  for (const task of tasks) {
    if (!isLocalAgentTask(task)) continue
    if (task.isBackgrounded || task.status !== 'running') continue
    backgroundAgentTask(task.id, getAppState, setAppState)
  }
}


export const LocalShellTask: Task = {
  name: 'LocalShellTask',
  type: 'local_bash',
  async kill(taskId, setAppState) {
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
