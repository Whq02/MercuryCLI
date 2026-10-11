import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTaskListId, isTaskToolsEnabled, listTasks, TASK_STATUSES } from '../../utils/tasks.js'
import { TASK_LIST_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

const inputSchema = lazySchema(() => z.strictObject({}))
const taskRow = lazySchema(() => z.object({ id: z.string(), subject: z.string(), status: z.enum(TASK_STATUSES), owner: z.string().optional(), blockedBy: z.string().array() }))
const outputSchema = lazySchema(() => z.object({ tasks: taskRow().array() }))
export type Output = z.infer<ReturnType<typeof outputSchema>>

type Row = Output['tasks'][number]

type StoredTask = Awaited<ReturnType<typeof listTasks>>[number]

const NO_TASKS = 'No tasks found'

const visible = (task: StoredTask): boolean => !task.metadata?._internal

function rowOf(task: StoredTask, completed: ReadonlySet<string>): Row {
  const owned = task.owner === undefined ? {} : { owner: task.owner }
  return { id: task.id, subject: task.subject, status: task.status, ...owned, blockedBy: task.blockedBy.filter(id => !completed.has(id)) }
}

const hashed = (ids: string[]): string => ids.map(id => `#${id}`).join(', ')

function lineOf(task: Row): string {
  const parts = [`#${task.id} [${task.status}] ${task.subject}`]
  if (task.owner) parts.push(` (${task.owner})`)
  if (task.blockedBy.length > 0) parts.push(` [blocked by ${hashed(task.blockedBy)}]`)
  return parts.join('')
}

async function rowsOfCurrentList(): Promise<Output> {
  const shown = (await listTasks(getTaskListId())).filter(visible)
  const completed = new Set(shown.filter(task => task.status === 'completed').map(task => task.id))
  return { tasks: shown.map(task => rowOf(task, completed)) }
}

export const TaskListTool = buildTool({
  name: TASK_LIST_TOOL_NAME,
  searchHint: 'list all tasks in the task list',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  get inputSchema(): ReturnType<typeof inputSchema> { return inputSchema() },
  get outputSchema(): ReturnType<typeof outputSchema> { return outputSchema() },
  isEnabled: () => isTaskToolsEnabled(),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  userFacingName: () => 'TaskList',
  description: async () => DESCRIPTION,
  prompt: async () => getPrompt(),
  call: async () => ({ data: await rowsOfCurrentList() }),
  mapToolResultToToolResultBlockParam: (output: Output, toolUseID: string) => ({ tool_use_id: toolUseID, type: 'tool_result' as const, content: output.tasks.length === 0 ? NO_TASKS : output.tasks.map(lineOf).join('\n') }),
  renderToolUseMessage: () => null,
} satisfies ToolDef<ReturnType<typeof inputSchema>, Output>)
