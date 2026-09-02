import { z } from 'zod/v4'

import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { executeTaskCreatedHooks, getTaskCreatedHookMessage } from '../../utils/hooks.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { createTask, deleteTask, getTaskListId, isTodoV2Enabled } from '../../utils/tasks.js'
import { getAgentName, getTeamName } from '../../utils/teammate.js'
import { TASK_CREATE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

/**
 * Creates a task in the task list, runs the task-created hook chain, and
 * auto-expands the task view. Deliberately NOT concurrency-safe: it
 * read-modify-writes the shared store, and a same-batch create racing an
 * update could make the update read "task not found" for an id its sibling
 * was still writing.
 */

const inputSchema = lazySchema(() =>
  z.strictObject({
    subject: z.string().describe('A brief title for the task, in the imperative form'),
    description: z.string().describe('What needs to be done'),
    activeForm: z
      .string()
      .optional()
      .describe('Present-continuous phrase shown in the spinner while the task is in progress'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Free-form metadata for the task'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    task: z.object({
      id: z.string(),
      subject: z.string(),
    }),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const TaskCreateTool = buildTool({
  name: TASK_CREATE_TOOL_NAME,
  searchHint: 'create a new task in the task list',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled: () => isTodoV2Enabled(),
  userFacingName: () => 'TaskCreate',
  toAutoClassifierInput(input: Input): string {
    return input.subject
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  async call(input: Input, context: ToolUseContext) {
    const taskListId = getTaskListId()
    const taskId = await createTask(taskListId, {
      subject: input.subject,
      description: input.description,
      activeForm: input.activeForm,
      status: 'pending',
      owner: undefined,
      blocks: [],
      blockedBy: [],
      metadata: input.metadata,
    })

    const blockingMessages: string[] = []
    for await (const result of executeTaskCreatedHooks(
      taskId,
      input.subject,
      input.description,
      getAgentName(),
      getTeamName(),
      undefined,
      context.abortController.signal,
      undefined,
      context,
    )) {
      if (result.blockingError) blockingMessages.push(getTaskCreatedHookMessage(result.blockingError))
    }
    if (blockingMessages.length > 0) {
      // Never leave a half-approved task behind.
      await deleteTask(taskListId, taskId)
      throw new Error(blockingMessages.join('\n'))
    }

    // Idempotent: state is left untouched when the view is already expanded.
    context.setAppState(prevState =>
      prevState.expandedView === 'tasks' ? prevState : { ...prevState, expandedView: 'tasks' },
    )

    return { data: { task: { id: taskId, subject: input.subject } } satisfies Output }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: `Task #${output.task.id} created successfully: ${output.task.subject}`,
    }
  },
  renderToolUseMessage: () => null,
} satisfies ToolDef<InputSchema, Output>)
