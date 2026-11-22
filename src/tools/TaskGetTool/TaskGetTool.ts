import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTask, getTaskListId, isTaskToolsEnabled, TASK_STATUSES } from '../../utils/tasks.js'
import { TASK_GET_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

const inputSchema = lazySchema(() => z.strictObject({ taskId: z.string().describe('The id of the task to retrieve') }))
const outputSchema = lazySchema(() => z.object({ task: z.object({
  id: z.string(), subject: z.string(), description: z.string(), status: z.enum(TASK_STATUSES),
  blocks: z.array(z.string()), blockedBy: z.array(z.string()),
}).nullable() }))
type InputSchema = ReturnType<typeof inputSchema>
type Output = z.infer<ReturnType<typeof outputSchema>>

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

export const TaskGetTool: Unbuilt = unbuilt('src/tools/TaskGetTool/TaskGetTool.ts:35')
