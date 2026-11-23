import { z } from 'zod/v4'

import { isLocalAgentTask } from '../../engine/tasks/local-agent/crewmateTask.js'
import { isLocalShellTask, type LocalShellTaskState } from '../../engine/tasks/local-shell/shellTaskState.js'
import { isTerminalTaskStatus, type TaskStateBase } from '../../engine/tasks/taskBase.js'
import {
  bareMissWords,
  finishedAgentFromRow,
  finishedAgentWords,
  finishedShellFromRow,
  finishedShellWords,
  finishedTaskOnDisk,
  isPausedAgentRow,
  resolveStopTargetId,
  stopTask,
  stoppedWhilePausedWords,
  type FinishedAgent,
  type FinishedShell,
} from '../../engine/tasks/stopTask.js'
import { buildTool, type ToolDef, type ToolUseContext, type ValidationResult } from '../kit/tool.js'
import { lazySchema } from '../../platform/primitives/lazySchema.js'
import { DESCRIPTION as PROMPT, TASK_STOP_TOOL_NAME } from '../kit/names/taskStop.js'
import { settledStopSentence } from './stopSettlement.js'
import { renderToolResultMessage, renderToolUseMessage } from './rows.js'

const KILL_SHELL_ALIAS = 'KillShell'

const DESCRIPTION =
  'Stops a running background task by its id. A task that already finished is answered with how it ended, when, and where its output file is; nothing is stopped and that is not an error.'

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

const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('The human-readable stop outcome'),
    task_id: z.string().describe('The id of the stopped task'),
    task_type: z.string().describe("The stopped task's type"),
    command: z.string().optional().describe('The command the task was running'),
    settled: z.boolean().optional().describe('Whether the process settled within the kill grace'),
    exit_code: z
      .number()
      .optional()
      .describe(
        "The process exit code, when it settled — the platform's own detail (POSIX 137 for a stop, win32 the code cmd.exe reports under taskkill, 1)",
      ),
    interrupted: z
      .boolean()
      .optional()
      .describe(
        "The stop's provenance: true when the stop itself ended the process, on every platform; false when it had settled on its own first",
      ),
    processes_ended: z
      .number()
      .optional()
      .describe('How many processes the stop ended — the whole tree, not just the leader'),
    process_survivors: z.number().optional().describe('How many pids outlived the bounded reap, when any did'),
    already_finished: z
      .string()
      .optional()
      .describe(
        "Present when nothing was stopped because the task had already ended: how it ended (completed · failed · been stopped · timed out · been ended by policy; for a crewmate no longer in the registry, its transcript's end: completed · failed · stopped · cut off …)",
      ),
    finished_at: z.string().optional().describe('When the already-finished task ended (ISO 8601)'),
    output_path: z.string().optional().describe("Where the already-finished task's output file is"),
  }),
)
export type Output = z.infer<ReturnType<typeof outputSchema>>

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
  return isLocalAgentTask(task) && isTerminalTaskStatus(task.status)
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

function alreadyFinishedAgentOutput(agent: FinishedAgent, message: string): Output {
  return {
    message,
    task_id: agent.taskId,
    task_type: 'local_agent',
    ...(agent.description !== undefined ? { command: agent.description } : {}),
    already_finished: agent.ended,
    ...(agent.endedAt !== undefined ? { finished_at: new Date(agent.endedAt).toISOString() } : {}),
    output_path: agent.outputPath,
  }
}

function childStopRefusal(context: ToolUseContext, task: unknown): string | null {
  if (context.agentId === undefined) return null
  return isLocalShellTask(task) && task.agentId === context.agentId
    ? null
    : 'A crewmate can stop only its own background command.'
}

export const TaskStopTool = buildTool({
  name: TASK_STOP_TOOL_NAME,
  aliases: [KILL_SHELL_ALIAS],
  userFacingName: () => 'Stop Task',
  searchHint: 'kill or stop a running background task',
  shouldDefer: true,
  isConcurrencySafe: () => false,
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema() {
    return outputSchema()
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  async validateInput(input: Input, context: ToolUseContext): Promise<ValidationResult> {
    const taskId = targetIdOf(input, context)
    if (!taskId) {
      return {
        result: false,
        message: 'Either task_id or shell_id is required.',
        errorCode: 1,
      }
    }
    const task = context.getAppState().tasks?.[taskId]
    const refusal = childStopRefusal(context, task)
    if (refusal !== null) {
      return {
        result: false,
        message: refusal,
        errorCode: 4,
      }
    }
    if (!task) {
      const onDisk = await finishedTaskOnDisk(taskId)
      if (onDisk !== null) return { result: true }
      return {
        result: false,
        message: bareMissWords(taskId),
        errorCode: 1,
      }
    }
    if (task.status !== 'running' && !isFinishedShellRow(task) && !isFinishedAgentRow(task)) {
      return {
        result: false,
        message: `Task ${taskId} is not running (status: ${task.status})`,
        errorCode: 3,
      }
    }
    return { result: true }
  },
  async call(input: Input, context: ToolUseContext): Promise<{ data: Output }> {
    const taskId = targetIdOf(input, context)
    if (!taskId) {
      throw new Error('Either task_id or shell_id is required.')
    }
    const task = context.getAppState().tasks?.[taskId]
    const refusal = childStopRefusal(context, task)
    if (refusal !== null) {
      throw new Error(refusal)
    }
    if (!task) {
      const onDisk = await finishedTaskOnDisk(taskId)
      if (onDisk !== null) {
        if (onDisk.kind === 'shell') {
          return { data: alreadyFinishedOutput(onDisk.shell) }
        }
        return { data: alreadyFinishedAgentOutput(onDisk.agent, `${onDisk.words}; nothing was stopped`) }
      }
    }
    if (isFinishedShellRow(task)) {
      return { data: alreadyFinishedOutput(finishedShellFromRow(task)) }
    }
    if (isFinishedAgentRow(task) && !isPausedAgentRow(task)) {
      const agent = finishedAgentFromRow(task)
      return { data: alreadyFinishedAgentOutput(agent, finishedAgentWords(agent)) }
    }
    const stopped = await stopTask(taskId, {
      getAppState: context.getAppState,
      setAppState: context.setAppState,
    })
    if (stopped.pausedStop !== undefined) {
      return {
        data: {
          message: stoppedWhilePausedWords(stopped.taskId, stopped.pausedStop),
          task_id: stopped.taskId,
          task_type: stopped.taskType,
          command: stopped.command,
        },
      }
    }
    let message = `Stopped task ${stopped.taskId} (${stopped.command}).`
    const settlement = stopped.settlement
    if (settlement !== undefined) {
      if (settlement.settled) {
        message += settledStopSentence(settlement)
        if (settlement.processesEnded !== undefined) {
          const unit = settlement.processesEnded === 1 ? 'process' : 'processes'
          const survivorsClause = settlement.processSurvivors
            ? `; ${settlement.processSurvivors} did not confirm ending within the reap bound`
            : ''
          message += ` The stop ended ${settlement.processesEnded} ${unit}${survivorsClause}.`
        }
      } else {
        message +=
          ' The kill was issued but the process had not settled within the grace window; it may still be terminating.'
      }
    }
    return {
      data: {
        message,
        task_id: stopped.taskId,
        task_type: stopped.taskType,
        command: stopped.command,
        ...(settlement !== undefined
          ? {
              settled: settlement.settled,
              ...(settlement.exitCode !== undefined ? { exit_code: settlement.exitCode } : {}),
              ...(settlement.interrupted !== undefined ? { interrupted: settlement.interrupted } : {}),
              ...(settlement.processesEnded !== undefined
                ? { processes_ended: settlement.processesEnded }
                : {}),
              ...(settlement.processSurvivors !== undefined
                ? { process_survivors: settlement.processSurvivors }
                : {}),
            }
          : {}),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: JSON.stringify(output),
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, Output>)
