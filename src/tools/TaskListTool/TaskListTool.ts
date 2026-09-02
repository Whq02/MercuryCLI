import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTaskListId, isTodoV2Enabled, listTasks, TASK_STATUSES } from '../../utils/tasks.js'
import { TASK_LIST_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

/** Lists all non-internal tasks with live blocker filtering. */

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    tasks: z.array(
      z.object({
        id: z.string(),
        subject: z.string(),
        status: z.enum(TASK_STATUSES),
        owner: z.string().optional(),
        blockedBy: z.array(z.string()),
      }),
    ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const TaskListTool = buildTool({
  name: TASK_LIST_TOOL_NAME,
  searchHint: 'list all tasks in the task list',
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
  userFacingName: () => 'TaskList',
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  async call() {
    const all = await listTasks(getTaskListId())
    // Internal-marker tasks are excluded entirely (contract data: a truthy
    // `_internal` metadata key).
    const visible = all.filter(task => !task.metadata?._internal)
    // The completed set is computed over the already-filtered list, so a
    // completed internal task never clears a blocker.
    const completed = new Set(visible.filter(task => task.status === 'completed').map(task => task.id))
    const tasks: Output['tasks'] = visible.map(task => ({
      id: task.id,
      subject: task.subject,
      status: task.status,
      ...(task.owner !== undefined ? { owner: task.owner } : {}),
      blockedBy: task.blockedBy.filter(id => !completed.has(id)),
    }))
    return { data: { tasks } satisfies Output }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    const content =
      output.tasks.length === 0
        ? 'No tasks found'
        : output.tasks
            .map(task => {
              const owner = task.owner ? ` (${task.owner})` : ''
              const blocked =
                task.blockedBy.length > 0 ? ` [blocked by ${task.blockedBy.map(id => `#${id}`).join(', ')}]` : ''
              return `#${task.id} [${task.status}] ${task.subject}${owner}${blocked}`
            })
            .join('\n')
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content,
    }
  },
  renderToolUseMessage: () => null,
} satisfies ToolDef<InputSchema, Output>)
