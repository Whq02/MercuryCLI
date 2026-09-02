import { z } from 'zod/v4'

import { stopTask } from '../../tasks/stopTask.js'
import { buildTool, type ToolDef, type ToolUseContext, type ValidationResult } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { DESCRIPTION as PROMPT, TASK_STOP_TOOL_NAME } from './prompt.js'
import { settledStopSentence } from './stopSettlement.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

/**
 * Stops a running background task by id, with a settlement-honest receipt:
 * asking a process to stop and knowing that it stopped are different facts,
 * and the model is told which one it has.
 */

/** Backward-compatible alias for existing transcripts and SDK users (contract data). */
const KILL_SHELL_ALIAS = 'KillShell'

const DESCRIPTION = 'Stops a running background task by its id.'

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

// The last three fields are optional because tool outputs are replayed from
// transcripts on resume without re-validation, and older sessions predate
// them.
const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('The human-readable stop outcome'),
    task_id: z.string().describe('The id of the stopped task'),
    task_type: z.string().describe('The stopped task\'s type'),
    command: z.string().optional().describe('The command the task was running'),
    settled: z.boolean().optional().describe('Whether the process settled within the kill grace'),
    exit_code: z.number().optional().describe('The process exit code, when it settled — the platform\'s own detail (POSIX 137 for a stop, win32 the code cmd.exe reports under taskkill, 1)'),
    interrupted: z
      .boolean()
      .optional()
      .describe('The stop\'s provenance: true when the stop itself ended the process, on every platform; false when it had settled on its own first'),
    processes_ended: z
      .number()
      .optional()
      .describe('How many processes the stop ended — the whole tree, not just the leader'),
    process_survivors: z
      .number()
      .optional()
      .describe('How many pids outlived the bounded reap, when any did'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

/** task_id wins when both are present. */
function taskIdOf(input: Partial<Input> | undefined): string | undefined {
  return input?.task_id ?? input?.shell_id
}

export const TaskStopTool = buildTool({
  name: TASK_STOP_TOOL_NAME,
  aliases: [KILL_SHELL_ALIAS],
  searchHint: 'kill or stop a running background task',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe: () => true,
  userFacingName: () => 'Stop Task',
  toAutoClassifierInput(input: Input): string {
    return taskIdOf(input) ?? ''
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  async validateInput(input: Input, context: ToolUseContext): Promise<ValidationResult> {
    const taskId = taskIdOf(input)
    if (!taskId) {
      return { result: false, message: 'Either task_id or shell_id is required.', errorCode: 1 }
    }
    const task = context.getAppState().tasks?.[taskId]
    if (!task) {
      return { result: false, message: `No task found with id ${taskId}`, errorCode: 1 }
    }
    if (task.status !== 'running') {
      return {
        result: false,
        message: `Task ${taskId} is not running (status: ${task.status})`,
        errorCode: 3,
      }
    }
    return { result: true }
  },
  async call(input: Input, context: ToolUseContext) {
    const taskId = taskIdOf(input)
    if (!taskId) throw new Error('Either task_id or shell_id is required.')
    const result = await stopTask(taskId, {
      getAppState: context.getAppState,
      setAppState: context.setAppState,
    })

    // Settlement honesty: never a bare acknowledgement. A counted sweep says
    // how many processes the stop ended — the whole tree, not just the leader.
    let settlementClause = ''
    if (result.settlement) {
      const ended = result.settlement.processesEnded
      const survivors = result.settlement.processSurvivors
      const endedClause =
        ended !== undefined
          ? ` The stop ended ${ended} process${ended === 1 ? '' : 'es'}${
              survivors ? `; ${survivors} did not confirm ending within the reap bound` : ''
            }.`
          : ''
      if (result.settlement.settled) {
        settlementClause = settledStopSentence(result.settlement) + endedClause
      } else {
        settlementClause =
          ' The kill was issued but the process had not settled within the grace window; it may still be terminating.'
      }
    }

    const output: Output = {
      message: `Stopped task ${result.taskId} (${result.command}).${settlementClause}`,
      task_id: result.taskId,
      task_type: result.taskType,
      command: result.command,
      ...(result.settlement
        ? {
            settled: result.settlement.settled,
            ...(result.settlement.exitCode !== undefined ? { exit_code: result.settlement.exitCode } : {}),
            ...(result.settlement.interrupted !== undefined ? { interrupted: result.settlement.interrupted } : {}),
            ...(result.settlement.processesEnded !== undefined
              ? { processes_ended: result.settlement.processesEnded }
              : {}),
            ...(result.settlement.processSurvivors !== undefined
              ? { process_survivors: result.settlement.processSurvivors }
              : {}),
          }
        : {}),
    }
    return { data: output }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: JSON.stringify(output),
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, Output>)
