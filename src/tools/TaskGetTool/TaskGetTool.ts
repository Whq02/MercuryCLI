import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTask, getTaskListId, isTodoV2Enabled, TASK_STATUSES } from '../../utils/tasks.js'
import { TASK_GET_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

/** Retrieves one task by id; a missing task is a null task, not an error. */

const inputSchema = lazySchema(() =>
  z.strictObject({
    taskId: z.string().describe('The id of the task to retrieve'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    task: z
      .object({
        id: z.string(),
        subject: z.string(),
        description: z.string(),
        status: z.enum(TASK_STATUSES),
        blocks: z.array(z.string()),
        blockedBy: z.array(z.string()),
      })
      .nullable(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const TaskGetTool = buildTool({
  name: TASK_GET_TOOL_NAME,
  searchHint: 'retrieve a task by id from the task list',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled: () => isTodoV2Enabled(),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  userFacingName: () => 'TaskGet',
  toAutoClassifierInput(input: Input): string {
    return input.taskId
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  async call(input: Input) {
    const task = await getTask(getTaskListId(), input.taskId)
    if (!task) return { data: { task: null } satisfies Output }
    return {
      data: {
        task: {
          id: task.id,
          subject: task.subject,
          description: task.description,
          status: task.status,
          blocks: task.blocks,
          blockedBy: task.blockedBy,
        },
      } satisfies Output,
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    const task = output.task
    if (!task) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: 'Task not found',
      }
    }
    const lines = [`#${task.id}: ${task.subject}`, `Status: ${task.status}`, `Description: ${task.description}`]
    if (task.blockedBy.length > 0) lines.push(`Blocked by: ${task.blockedBy.map(id => `#${id}`).join(', ')}`)
    if (task.blocks.length > 0) lines.push(`Blocks: ${task.blocks.map(id => `#${id}`).join(', ')}`)
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: lines.join('\n'),
    }
  },
  renderToolUseMessage: () => null,
} satisfies ToolDef<InputSchema, Output>)
