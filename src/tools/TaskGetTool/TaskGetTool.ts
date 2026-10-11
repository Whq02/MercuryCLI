import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTask, getTaskListId, isTaskToolsEnabled, TASK_STATUSES } from '../../utils/tasks.js'
import { TASK_GET_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

const inputSchema = lazySchema(() => z.strictObject({ taskId: z.string().describe('The id of the task to retrieve') }))
const outputSchema = lazySchema(() => z.object({ task: z.object({
  id: z.string(), subject: z.string(), description: z.string(), status: z.enum(TASK_STATUSES),
  blocks: z.array(z.string()), blockedBy: z.array(z.string()),
}).nullable() }))
type InputSchema = ReturnType<typeof inputSchema>
export type Output = z.infer<ReturnType<typeof outputSchema>>

async function readTask({ taskId }: z.infer<InputSchema>): Promise<{ data: Output }> {
  const found = await getTask(getTaskListId(), taskId)
  let task: Output['task'] = null
  if (found) {
    const { id, subject, description, status, blocks, blockedBy } = found
    task = { id, subject, description, status, blocks, blockedBy }
  }
  return { data: { task } }
}

function taskText(task: Output['task']): string {
  if (!task) return 'Task not found'
  const dependencies: Array<[string, string[]]> = [['Depends on', task.blockedBy], ['Blocks', task.blocks]]
  return [
    `#${task.id}: ${task.subject}`, `Status: ${task.status}`, `Description: ${task.description}`,
    ...dependencies.flatMap(([label, ids]) => ids.length ? [`${label}: ${ids.map(id => '#' + id).join(', ')}`] : []),
  ].join('\n')
}

export const TaskGetTool = buildTool({
  call: readTask,
  mapToolResultToToolResultBlockParam: (output: Output, toolUseID: string) => ({ type: 'tool_result' as const, tool_use_id: toolUseID, content: taskText(output.task) }),
  renderToolUseMessage: () => null,
  name: TASK_GET_TOOL_NAME,
  searchHint: 'retrieve a task by id from the task list',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  get inputSchema() { return inputSchema() },
  get outputSchema() { return outputSchema() },
  isEnabled: () => isTaskToolsEnabled(),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  userFacingName: () => 'TaskGet',
  description: async () => DESCRIPTION,
  prompt: async () => PROMPT,
} satisfies ToolDef<InputSchema, Output>)
