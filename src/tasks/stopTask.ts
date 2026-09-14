import { existsSync } from 'node:fs'
import { getSessionId } from '../bootstrap/state.js'
import type { SetAppState, TaskKillReceipt, TaskType } from '../Task.js'
import type { AppState } from '../state/AppState.js'
import { getTaskByType } from '../tasks.js'
import { readAgentTranscript } from '../tools/WorkflowTool/agentTranscriptReader.js'
import { asAgentId } from '../types/ids.js'
import { getAgentTranscriptPath } from '../utils/sessionStorage/paths.js'
import { emitTaskTerminatedSdk } from '../utils/sdkEventQueue.js'
import { updateTaskState } from '../utils/task/framework.js'
import { isLocalShellTask, type LocalShellTaskState } from './LocalShellTask/guards.js'
import { findTaskOutcome, type TaskOutcomeEnvelope, type TaskOutcomeState } from './taskOutcomeEnvelope.js'


export type StopTaskErrorCode = 'not_found' | 'not_running' | 'unsupported_type'

export class StopTaskError extends Error {
  code: StopTaskErrorCode

  constructor(code: StopTaskErrorCode, message: string) {
    super(message)
    this.name = 'StopTaskError'
    this.code = code
  }
}

export async function taskNotFoundWords(taskId: string): Promise<string> {
  return (await finishedTaskOnDisk(taskId))?.words ?? bareMissWords(taskId)
}

export const bareMissWords = (taskId: string): string => `No task found with id ${taskId}`

export type FinishedShell = {
  taskId: string
  command: string
  ended: string
  endedAt: number
  exitCode?: number
  outputPath?: string
}

export type FinishedTaskOnDisk =
  | { kind: 'agent'; words: string }
  | { kind: 'shell'; words: string; shell: FinishedShell }

function endedWord(state: TaskOutcomeState): string {
  switch (state) {
    case 'succeeded':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'stopped':
      return 'been stopped'
    case 'timed-out':
      return 'timed out'
    case 'killed-policy':
      return 'been ended by policy'
    default:
      return 'ended'
  }
}

export function finishedShellFromOutcome(outcome: TaskOutcomeEnvelope): FinishedShell {
  return {
    taskId: outcome.taskId,
    command: outcome.command,
    ended: endedWord(outcome.state),
    endedAt: outcome.endTime,
    ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
    ...(outcome.output?.artifactPath ? { outputPath: outcome.output.artifactPath } : {}),
  }
}

export function finishedShellFromRow(task: LocalShellTaskState): FinishedShell {
  return {
    taskId: task.id,
    command: task.command,
    ended: task.status === 'killed' ? 'been stopped' : task.status === 'failed' ? 'failed' : 'completed',
    endedAt: task.endTime ?? task.startTime,
    ...(task.result ? { exitCode: task.result.code } : {}),
    outputPath: task.outputFile,
  }
}

export function finishedShellWords(shell: FinishedShell): string {
  const exit = shell.exitCode !== undefined ? ` (exit code ${shell.exitCode})` : ''
  const where = shell.outputPath ? `; its output file is ${shell.outputPath} — read it directly` : '; no output file was retained'
  return `Task ${shell.taskId} (${shell.command}) had already ${shell.ended}${exit} at ${new Date(shell.endedAt).toISOString()}; nothing was stopped${where}`
}

export async function finishedTaskOnDisk(taskId: string): Promise<FinishedTaskOnDisk | null> {
  let transcriptPath: string | null = null
  try {
    transcriptPath = getAgentTranscriptPath(asAgentId(taskId))
  } catch {
    transcriptPath = null
  }
  if (transcriptPath !== null && existsSync(transcriptPath)) {
    const view = await readAgentTranscript(transcriptPath)
    return {
      kind: 'agent',
      words: `No running task with id ${taskId} in this session's registry — its transcript on disk ends ${view?.end.words ?? 'unreadable'}; a message to that id (SendMessage) resumes it`,
    }
  }
  const outcome = await findTaskOutcome(getSessionId(), taskId)
  if (outcome !== undefined && outcome.taskType === 'local_bash') {
    const shell = finishedShellFromOutcome(outcome)
    return { kind: 'shell', words: finishedShellWords(shell), shell }
  }
  return null
}

export async function stopTask(
  taskId: string,
  context: { getAppState: () => AppState; setAppState: SetAppState },
): Promise<{
  taskId: string
  taskType: TaskType
  command: string
  settlement?: TaskKillReceipt
}> {
  const task = context.getAppState().tasks?.[taskId]
  if (!task) {
    throw new StopTaskError('not_found', await taskNotFoundWords(taskId))
  }
  if (task.status !== 'running') {
    throw new StopTaskError(
      'not_running',
      `Task ${taskId} is not running (status: ${task.status})`,
    )
  }
  const implementation = getTaskByType(task.type as TaskType)
  if (!implementation) {
    throw new StopTaskError(
      'unsupported_type',
      `Stopping tasks of type ${task.type} is not supported`,
    )
  }

  const killReturn = await implementation.kill(taskId, context.setAppState)
  const settlement =
    typeof killReturn === 'object' &&
    killReturn !== null &&
    typeof (killReturn as { settled?: unknown }).settled === 'boolean'
      ? (killReturn as TaskKillReceipt)
      : undefined

  if (isLocalShellTask(task)) {
    let flippedHere = false
    updateTaskState(taskId, context.setAppState, current => {
      if (current.notified) return current
      flippedHere = true
      return { ...current, notified: true }
    })
    if (flippedHere) {
      emitTaskTerminatedSdk(taskId, 'stopped', {
        toolUseId: task.toolUseId,
        summary: task.description,
      })
    }
  }

  return {
    taskId,
    taskType: task.type as TaskType,
    command: isLocalShellTask(task) ? task.command : task.description,
    settlement,
  }
}
