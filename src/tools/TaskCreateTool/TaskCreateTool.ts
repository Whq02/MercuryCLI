import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { createTask, getTaskListId, isTaskToolsEnabled } from '../../utils/tasks.js'
import { TASK_CREATE_TOOL_NAME } from '../../constants/tools/taskCreate.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

const inputSchema: Unbuilt = unbuilt('src/tools/TaskCreateTool/TaskCreateTool.ts:8')
const outputSchema: Unbuilt = unbuilt('src/tools/TaskCreateTool/TaskCreateTool.ts:14')
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>
type Output = z.infer<ReturnType<typeof outputSchema>>

const pendingTask = ({ subject, description, activeForm, metadata }: Input) => ({
  subject, description, activeForm, status: 'pending' as const,
  owner: undefined, blocks: [] as string[], blockedBy: [] as string[], metadata,
})

const expandTasks = (state: ReturnType<ToolUseContext['getAppState']>) =>
  state.expandedView === 'tasks' ? state : { ...state, expandedView: 'tasks' as const }

async function addTask(input: Input, context: ToolUseContext): Promise<{ data: Output }> {
  const list = getTaskListId()
  const id = await createTask(list, pendingTask(input))
  context.setAppState(expandTasks)
  return { data: { task: { id, subject: input.subject } } }
}

export const TaskCreateTool: Unbuilt = unbuilt('src/tools/TaskCreateTool/TaskCreateTool.ts:34')
