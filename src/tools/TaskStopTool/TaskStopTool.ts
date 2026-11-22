import { z } from 'zod/v4'

import { isLocalShellTask, type LocalShellTaskState } from '../../tasks/LocalShellTask/guards.js'
import { isTerminalTaskStatus, type TaskStateBase } from '../../Task.js'
import { bareMissWords, finishedAgentFromRow, finishedAgentWords, finishedShellFromRow, finishedShellWords, finishedTaskOnDisk, isPausedAgentRow, resolveStopTargetId, stopTask, stoppedWhilePausedWords, type FinishedAgent, type FinishedShell } from '../../tasks/stopTask.js'
import { buildTool, type ToolDef, type ToolUseContext, type ValidationResult } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { DESCRIPTION as PROMPT, TASK_STOP_TOOL_NAME } from '../../constants/tools/taskStop.js'
import { settledStopSentence } from './stopSettlement.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'


const KILL_SHELL_ALIAS = 'KillShell'

const DESCRIPTION = 'Stops a running background task by its id. A task that already finished is answered with how it ended, when, and where its output file is; nothing is stopped and that is not an error.'

const inputSchema = lazySchema(() =>
  z.strictObject({
    task_id: z.string().optional().describe('The id of the background task to stop'),
    shell_id: z
      .string()
      .optional()
      .describe('Deprecated: use task_id instead. The id of the background shell to stop.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>
export type Output = Unbuilt

function taskIdOf(input: Partial<Input> | undefined): string | undefined {
  return input?.task_id ?? input?.shell_id
}

function targetIdOf(input: Partial<Input> | undefined, context: ToolUseContext): string | undefined {
  const raw = taskIdOf(input)
  return raw === undefined ? undefined : resolveStopTargetId(raw, context.getAppState())
}

function isFinishedShellRow(task: unknown): task is LocalShellTaskState {
  return isLocalShellTask(task) && isTerminalTaskStatus(task.status)
}

function isFinishedAgentRow(task: unknown): task is TaskStateBase & { type: 'local_agent' } {
  return typeof task === 'object' && task !== null && (task as { type?: unknown }).type === 'local_agent' && isTerminalTaskStatus((task as TaskStateBase).status)
}

function alreadyFinishedOutput(shell: FinishedShell): Output {
  return {
    message: finishedShellWords(shell),
    task_id: shell.taskId,
    task_type: 'local_bash',
    command: shell.command,
    already_finished: shell.ended,
    finished_at: new Date(shell.endedAt).toISOString(),
    ...(shell.outputPath !== undefined ? { output_path: shell.outputPath } : {}),
    ...(shell.exitCode !== undefined ? { exit_code: shell.exitCode } : {}),
  }
}

function childStopRefusal(context: ToolUseContext, task: unknown): string | null {
  if (context.agentId === undefined) return null
  return isLocalShellTask(task) && task.agentId === context.agentId
    ? null
    : 'A crewmate can stop only its own background command.'
}

export const TaskStopTool: Unbuilt = unbuilt('src/tools/TaskStopTool/TaskStopTool.ts:109')
