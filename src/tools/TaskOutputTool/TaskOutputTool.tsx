import * as React from 'react'
import { z } from 'zod/v4'

import { getSessionId } from '../../bootstrap/state.js'
import { CtrlOToExpand } from '../../components/CtrlOToExpand.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { FallbackToolUseRejectedMessage } from '../../components/FallbackToolUseRejectedMessage.js'
import { Box, Text } from '../../ink.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isLocalShellTask } from '../../tasks/LocalShellTask/guards.js'
import { findTaskOutcome } from '../../tasks/taskOutcomeEnvelope.js'
import type { TaskState } from '../../tasks/types.js'
import { buildTool, type ToolCallProgress, type ToolDef, type ToolUseContext, type ValidationResult } from '../../Tool.js'
import type { ToolResultBlockParam } from '../../types/wire.js'
import type { TaskOutputProgress } from '../../types/tools.js'
import { AbortError } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { sleep } from '../../utils/sleep.js'
import { getTaskOutput } from '../../utils/task/diskOutput.js'
import { updateTaskState } from '../../utils/task/framework.js'
import { formatTaskOutput } from '../../utils/task/outputFormatting.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { AgentPromptDisplay, AgentResponseDisplay } from '../AgentTool/UI.js'
import BashToolResultMessage from '../BashTool/BashToolResultMessage.js'
import { TASK_OUTPUT_TOOL_NAME } from './constants.js'

/**
 * Reads output/status from a background task (shell, agent, remote),
 * blocking or not. After a clear/resume/reconnect the durable task-outcome
 * record answers instead of live state, and the search projection carries
 * the task's text.
 */

export type { TaskOutputProgress as Progress }

/** Backward-compatible aliases (contract data). */
const ALIASES = ['AgentOutputTool', 'BashOutputTool']

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 600_000
const POLL_INTERVAL_MS = 100
/** Characters of output painted for task types without a dedicated renderer. */
const GENERIC_OUTPUT_PREVIEW_CHARS = 500

const DESCRIPTION =
  'Deprecated: read the task output file directly instead (background tasks return their output file path in the tool result).'

const PROMPT = `Deprecated: prefer reading the task's output file directly. Background tasks return their output file path in the tool result, and the task-completion notification carries the same path.

- Retrieves output from a running or completed task (a shell command, an agent, or a remote agent).
- Takes a task_id identifying the task.
- Returns the task's output together with its status.
- Blocking is the default: the call waits until the task finishes or the timeout elapses. Pass block: false to check the current status without waiting.
- Task ids can be found through the tasks command.
- Works for all task types.`

const inputSchema = lazySchema(() =>
  z.strictObject({
    task_id: z.string().describe('The id of the background task to read'),
    block: semanticBoolean(z.boolean().default(true)).describe(
      'Whether to wait for the task to finish (default true)',
    ),
    timeout: semanticNumber(z.number().min(0).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS)).describe(
      'How long to wait, in milliseconds (default 30000, max 600000)',
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

type RetrievalStatus = 'success' | 'timeout' | 'not_ready'

export type TaskRecord = {
  task_id: string
  task_type: string
  status: string
  description: string
  output: string
  exitCode?: number | null
  error?: string
  prompt?: string
  result?: string
}

export type Output = {
  retrieval_status: RetrievalStatus
  task: TaskRecord | null
}

// ── output extraction ───────────────────────────────────────────────────────

/** Read a task's output by type: shell handles first, then disk; agents prefer the in-memory final answer. */
async function extractTaskRecord(task: TaskState): Promise<TaskRecord> {
  const base: TaskRecord = {
    task_id: task.id,
    task_type: task.type,
    status: task.status,
    description: task.description,
    output: '',
  }
  if (isLocalShellTask(task)) {
    let output = ''
    if (task.shellCommand) {
      const stdout = await task.shellCommand.taskOutput.getStdout()
      const stderr = task.shellCommand.taskOutput.getStderr()
      output = [stdout, stderr].filter(stream => stream.length > 0).join('\n')
    } else {
      output = await getTaskOutput(task.id)
    }
    return { ...base, output, exitCode: task.result?.code ?? null }
  }
  if (isLocalAgentTask(task)) {
    // The disk output is the whole session transcript; the in-memory result
    // is only the final assistant text — the clean answer wins.
    const diskOutput = await getTaskOutput(task.id)
    const answer = typeof task.result === 'string' ? task.result : ''
    const record: TaskRecord = {
      ...base,
      output: answer.length > 0 ? answer : diskOutput,
      prompt: task.prompt,
    }
    if (answer.length > 0) record.result = answer
    if (task.error) record.error = task.error
    return record
  }
  return { ...base, output: await getTaskOutput(task.id) }
}

function isSettled(status: string): boolean {
  return status !== 'running' && status !== 'pending'
}

function markNotified(taskId: string, context: ToolUseContext): void {
  updateTaskState(taskId, context.setAppState, task => ({ ...task, notified: true }))
}

async function answerFromDurableOutcome(taskId: string): Promise<Output> {
  const outcome = await findTaskOutcome(getSessionId(), taskId)
  if (!outcome) throw new Error(`Task ${taskId} not found`)
  const exitCode = outcome.exitCode !== undefined ? ` (exit code ${outcome.exitCode})` : ''
  const settledAt = new Date(outcome.endTime).toISOString()
  const artifact = outcome.output?.artifactPath
  const tail = artifact
    ? `This session no longer holds the live output; read the artifact directly: ${artifact}`
    : 'No output artifact was retained.'
  return {
    retrieval_status: 'success',
    task: {
      task_id: outcome.taskId,
      task_type: outcome.taskType,
      status: outcome.state,
      description: outcome.description ?? outcome.command,
      output: `Task settled with state ${outcome.state}${exitCode} at ${settledAt}. ${tail}`,
      exitCode: outcome.exitCode ?? null,
    },
  }
}

// ── the tool ────────────────────────────────────────────────────────────────

/** The read-only answer; concurrency safety delegates to it. */
const isReadOnly = (_input?: unknown): boolean => true

function parseOutput(output: Output | string | undefined): Output | undefined {
  if (typeof output !== 'string') return output
  try {
    return JSON.parse(output) as Output
  } catch {
    return undefined
  }
}

function tagged(tag: string, value: string): string {
  return `<${tag}>${value}</${tag}>`
}

export const TaskOutputTool = buildTool({
  name: TASK_OUTPUT_TOOL_NAME,
  aliases: ALIASES,
  searchHint: 'read output or logs from a background task',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  isEnabled: () => true,
  isReadOnly,
  // Derived by delegating to the read-only answer (a module-level function,
  // so it can never be absent).
  isConcurrencySafe: (input: Input) => isReadOnly(input),
  userFacingName: () => 'Task Output',
  toAutoClassifierInput(input: Input): string {
    return input.task_id
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  async validateInput(input: Input): Promise<ValidationResult> {
    if (!input.task_id || input.task_id.trim().length === 0) {
      return { result: false, message: 'task_id is required.', errorCode: 1 }
    }
    // A task id absent from session state still validates: resolution is
    // deferred to execution, where a durable outcome record may answer.
    return { result: true }
  },
  async call(
    input: Input,
    context: ToolUseContext,
    _canUseTool,
    _parentMessage,
    onProgress?: ToolCallProgress<TaskOutputProgress>,
  ) {
    const { task_id: taskId } = input
    const block = input.block ?? true
    const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS
    const readTask = (): TaskState | undefined => context.getAppState().tasks?.[taskId] as TaskState | undefined

    let task = readTask()
    if (!task) {
      return { data: await answerFromDurableOutcome(taskId) }
    }

    if (!block) {
      if (isSettled(task.status)) {
        markNotified(taskId, context)
        return { data: { retrieval_status: 'success', task: await extractTaskRecord(task) } satisfies Output }
      }
      return { data: { retrieval_status: 'not_ready', task: await extractTaskRecord(task) } satisfies Output }
    }

    onProgress?.({
      toolUseID: `waiting-${taskId}`,
      data: { type: 'waiting_for_task', taskDescription: task.description, taskType: task.type },
    })

    const deadline = Date.now() + timeout
    while (timeout > 0 && !isSettled(task.status)) {
      if (context.abortController.signal.aborted) throw new AbortError()
      if (Date.now() >= deadline) break
      await sleep(POLL_INTERVAL_MS)
      const next = readTask()
      if (!next) {
        // Disappeared mid-wait: the wait ends immediately.
        return { data: { retrieval_status: 'timeout', task: null } satisfies Output }
      }
      task = next
    }

    if (!isSettled(task.status)) {
      const current = readTask() ?? task
      return { data: { retrieval_status: 'timeout', task: await extractTaskRecord(current) } satisfies Output }
    }
    markNotified(taskId, context)
    return { data: { retrieval_status: 'success', task: await extractTaskRecord(task) } satisfies Output }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    const parts = [tagged('retrieval_status', output.retrieval_status)]
    const task = output.task
    if (task) {
      parts.push(tagged('task_id', task.task_id))
      parts.push(tagged('task_type', task.task_type))
      parts.push(tagged('status', task.status))
      if (task.exitCode !== undefined && task.exitCode !== null) {
        parts.push(tagged('exit_code', String(task.exitCode)))
      }
      if (task.output.trim().length > 0) {
        const formatted = formatTaskOutput(task.output, task.task_id).content.trimEnd()
        parts.push(`<output>\n${formatted}\n</output>`)
      }
      if (task.error) parts.push(tagged('error', task.error))
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: parts.join('\n\n'),
    }
  },
  extractSearchText(output: Output): string {
    const task = output?.task
    if (!task) return ''
    return [task.description, task.prompt, task.output, task.result, task.error]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join('\n')
  },
  isResultTruncated(output: Output | string): boolean {
    const parsed = parseOutput(output)
    const task = parsed?.task
    if (!parsed || !task) return false
    switch (task.task_type) {
      case 'local_bash':
        return isOutputLineTruncated(task.output)
      case 'local_agent':
        return parsed.retrieval_status === 'success' && Boolean(task.prompt || task.result || task.error)
      case 'remote_agent':
        return task.output.length > 0
      default:
        return false
    }
  },
  renderToolUseMessage(input?: Partial<Input>): React.ReactNode {
    return input?.block === false ? 'non-blocking' : ''
  },
  renderToolUseTag(input?: Partial<Input>): React.ReactNode {
    if (!input?.task_id) return null
    return <Text dimColor> {input.task_id}</Text>
  },
  renderToolUseProgressMessage(
    progressMessages: Array<{ data?: TaskOutputProgress }> | undefined,
  ): React.ReactNode {
    const latest = progressMessages?.[progressMessages.length - 1]?.data
    return (
      <MessageResponse>
        <Box flexDirection="column">
          {latest?.taskDescription ? <Text>{latest.taskDescription}</Text> : null}
          <Text>
            Waiting for task… <Text dimColor>(esc for additional instructions)</Text>
          </Text>
        </Box>
      </MessageResponse>
    )
  },
  renderToolUseRejectedMessage(): React.ReactNode {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolUseErrorMessage(result: ToolResultBlockParam['content'], { verbose }: { verbose: boolean }): React.ReactNode {
    return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
  },
  renderToolResultMessage(output: Output, _progressMessages: unknown, { verbose }: { verbose: boolean }): React.ReactNode {
    return <TaskOutputResult output={output} verbose={verbose} />
  },
} satisfies ToolDef<InputSchema, Output, TaskOutputProgress>)

// ── result rendering ────────────────────────────────────────────────────────

function TaskOutputResult({ output, verbose }: { output: Output; verbose: boolean }): React.ReactNode {
  const task = output.task
  if (!task) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>No task output available</Text>
      </MessageResponse>
    )
  }

  switch (task.task_type) {
    case 'local_bash':
      return (
        <BashToolResultMessage
          content={{
            stdout: task.output,
            stderr: '',
            isImage: false,
            returnCodeInterpretation: task.error,
          }}
          verbose={verbose}
        />
      )
    case 'local_agent':
      return <AgentTaskResult output={output} verbose={verbose} />
    case 'remote_agent':
      return (
        <MessageResponse>
        <Box flexDirection="column">
          <Text>
            {task.description} <Text dimColor>[{task.status}]</Text>
          </Text>
          {verbose ? (
            <Box marginLeft={2}>
              <Text>{task.output}</Text>
            </Box>
          ) : task.output.length > 0 ? (
            <Text dimColor>
              <CtrlOToExpand />
            </Text>
          ) : null}
        </Box>
        </MessageResponse>
      )
    default:
      return (
        <MessageResponse>
          <Box flexDirection="column">
            <Text>
              {task.description} <Text dimColor>[{task.status}]</Text>
            </Text>
            <Text>{task.output.slice(0, GENERIC_OUTPUT_PREVIEW_CHARS)}</Text>
          </Box>
        </MessageResponse>
      )
  }
}

function AgentTaskResult({ output, verbose }: { output: Output; verbose: boolean }): React.ReactNode {
  const task = output.task!
  if (output.retrieval_status === 'success') {
    if (!verbose) {
      return (
        <MessageResponse height={1}>
          <Text dimColor>
            Read the agent output <CtrlOToExpand />
          </Text>
        </MessageResponse>
      )
    }
    const lineCount = task.result ? task.result.split('\n').length : 0
    return (
      <MessageResponse>
      <Box flexDirection="column">
        <Text>
          {task.description} <Text dimColor>({lineCount} lines)</Text>
        </Text>
        {task.prompt ? <AgentPromptDisplay prompt={task.prompt} dim /> : null}
        {task.result ? <AgentResponseDisplay content={[{ type: 'text', text: task.result }]} /> : null}
        {task.error ? (
          <Box flexDirection="column">
            <Text color="error" bold>
              Error:
            </Text>
            <Text color="error">{task.error}</Text>
          </Box>
        ) : null}
      </Box>
      </MessageResponse>
    )
  }
  if (output.retrieval_status === 'timeout' || task.status === 'running' || output.retrieval_status === 'not_ready') {
    return (
      <MessageResponse height={1}>
        <Text dimColor>Task is still running…</Text>
      </MessageResponse>
    )
  }
  return (
    <MessageResponse height={1}>
      <Text dimColor>Task is not ready</Text>
    </MessageResponse>
  )
}

export default TaskOutputTool
