import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTaskListId, isTaskToolsEnabled, listTasks, TASK_STATUSES } from '../../utils/tasks.js'
import { TASK_LIST_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'

const inputSchema = lazySchema(() => z.strictObject({}))
const taskRow = lazySchema(() => z.object({ id: z.string(), subject: z.string(), status: z.enum(TASK_STATUSES), owner: z.string().optional(), blockedBy: z.string().array() }))
const outputSchema = lazySchema(() => z.object({ tasks: taskRow().array() }))
type Output = z.infer<ReturnType<typeof outputSchema>>

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

export const TaskListTool: Unbuilt = unbuilt('src/tools/TaskListTool/TaskListTool.ts:41')
