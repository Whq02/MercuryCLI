import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { createTask, getTaskListId, isTaskToolsEnabled } from '../../utils/tasks.js'
import { TASK_CREATE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

const inputSchema = lazySchema(() => z.strictObject({
  subject: z.string().describe('A brief title for the task, in the imperative form'),
  description: z.string().describe('What needs to be done'),
  activeForm: z.string().optional().describe('Present-continuous phrase shown in the spinner while the task is in progress'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('Free-form metadata for the task'),
}))
const outputSchema = lazySchema(() => z.object({ task: z.object({ id: z.string(), subject: z.string() }) }))
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>
export type Output = z.infer<ReturnType<typeof outputSchema>>

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

export const TaskCreateTool = buildTool({
  call: addTask,
  renderToolUseMessage: () => null,
  mapToolResultToToolResultBlockParam: ({ task }: Output, tool_use_id: string) => ({
    type: 'tool_result' as const, tool_use_id,
    content: `Task #${task.id} created successfully: ${task.subject}`,
  }),
  name: TASK_CREATE_TOOL_NAME,
  searchHint: 'create a new task in the task list',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  get inputSchema() { return inputSchema() },
  get outputSchema() { return outputSchema() },
  isEnabled: () => isTaskToolsEnabled(),
  userFacingName: () => 'TaskCreate',
  description: async () => DESCRIPTION,
  prompt: async () => getPrompt(),
} satisfies ToolDef<InputSchema, Output>)
